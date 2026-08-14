import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PeerClient } from '@useorgx/orgx-gateway-sdk';

import { DurableFailureDriver } from '../lib/peer/DurableFailureDriver.mjs';
import {
  ReceiptOutboxDriver,
  TerminalReceiptOutbox,
} from '../lib/peer/ReceiptOutbox.mjs';
import { persistReceiptEntry } from '../lib/peer/ReceiptOutboxStorage.mjs';

describe('durable failure recovery', () => {
  it('maps a post-start failure to a truthful blocked completion', async () => {
    const driver = new DurableFailureDriver(failingDriver());
    const messages = await collect(
      driver.dispatch(
        { title: 'Fail after start' },
        { run_id: 'run-blocked', idempotency_key: 'dispatch-blocked' }
      )
    );

    assert.deepEqual(
      messages.map((message) => message.kind),
      ['task.started', 'task.step', 'task.completed']
    );
    assert.match(
      messages[1].step.summary,
      /Execution blocked: provider failed/
    );
    assert.deepEqual(
      {
        outcome_kind: messages[2].outcome_kind,
        provider: messages[2].provider,
        source_sub_type: messages[2].source_sub_type,
        source_driver: messages[2].source_driver,
        tokens_used: messages[2].tokens_used,
        cost_estimate_cents: messages[2].cost_estimate_cents,
      },
      {
        outcome_kind: 'blocked',
        provider: 'other',
        source_sub_type: 'api_key',
        source_driver: 'deepseek_harness',
        tokens_used: 0,
        cost_estimate_cents: 0,
      }
    );
  });

  it('leaves a pre-start duplicate rejection as task.failed', async () => {
    const raw = {
      id: 'deepseek_harness',
      async *dispatch(_task, context) {
        yield {
          kind: 'task.failed',
          run_id: context.run_id,
          reason: 'run already active',
          recoverable: false,
        };
      },
      async detect() {},
      async probe() {},
      async cancel() {},
    };
    const messages = await collect(
      new DurableFailureDriver(raw).dispatch(
        { title: 'Duplicate' },
        { run_id: 'run-duplicate', idempotency_key: 'dispatch-duplicate' }
      )
    );
    assert.deepEqual(messages, [
      {
        kind: 'task.failed',
        run_id: 'run-duplicate',
        reason: 'run already active',
        recoverable: false,
      },
    ]);
  });

  it('maps a post-start cancellation to abandoned rather than blocked', async () => {
    const raw = failingDriver();
    raw.dispatch = async function* dispatch(_task, context) {
      yield {
        kind: 'task.started',
        run_id: context.run_id,
        started_at: '2026-08-14T12:00:00.000Z',
      };
      yield {
        kind: 'task.failed',
        run_id: context.run_id,
        reason: 'DeepSeek Harness run cancelled',
        recoverable: false,
      };
    };
    const messages = await collect(
      new DurableFailureDriver(raw).dispatch(
        { title: 'Cancel' },
        { run_id: 'run-cancelled', idempotency_key: 'dispatch-cancelled' }
      )
    );
    assert.equal(messages.at(-1).kind, 'task.completed');
    assert.equal(messages.at(-1).outcome_kind, 'abandoned');
    assert.match(messages.at(-2).step.summary, /Execution abandoned/);
  });

  it('posts through the application outbox even when ws.send returns without an acknowledgement', async () => {
    const outboxPath = await mkdtemp(join(tmpdir(), 'orgx-receipt-sdk-'));
    const socket = new FakeSocket();
    const requests = [];
    const request = async (url, init) => {
      requests.push({ url: String(url), init });
      return { ok: true, status: 201 };
    };
    const outbox = new TerminalReceiptOutbox({
      baseUrl: 'https://example.test',
      apiKey: 'oxk_test',
      env: { ORGX_RECEIPT_OUTBOX_PATH: outboxPath },
      fetch: request,
      logger: { warn() {} },
    });
    await outbox.prepare();
    const client = new PeerClient({
      baseUrl: 'wss://example.test',
      apiKey: 'oxk_test',
      workspaceId: 'workspace-1',
      pluginId: 'orgx-deepseek-harness-plugin',
      installationId: 'install.deepseek-1',
      protocolVersion: 1,
      drivers: [
        new ReceiptOutboxDriver(
          new DurableFailureDriver(failingDriver()),
          outbox
        ),
      ],
      reconnect: false,
      webSocketFactory: () => socket,
      fetch: request,
    });
    try {
      client.connect();
      socket.emit('open');
      socket.emit('message', {
        data: JSON.stringify({
          kind: 'task.dispatch',
          run_id: 'run-disconnected-failure',
          idempotency_key: 'dispatch-disconnected-failure',
          timeout_seconds: 30,
          task: { title: 'Fail', driver: 'deepseek_harness' },
        }),
      });

      await waitFor(() => requests.length === 1, 'HTTP failure receipt');
      assert.match(
        requests[0].url,
        /\/api\/v1\/runs\/run-disconnected-failure\/receipt$/
      );
      assert.equal(requests[0].init.headers.Authorization, 'Bearer oxk_test');
      const receipt = JSON.parse(requests[0].init.body);
      assert.equal(receipt.outcome_kind, 'blocked');
      assert.equal(receipt.source_driver, 'deepseek_harness');
      assert.equal(receipt.tokens_used, 0);
      assert.equal(receipt.cost_estimate_cents, 0);
      assert.equal(
        receipt.metadata.recovered_from,
        'deepseek_harness_receipt_outbox'
      );
      await waitFor(
        () => socket.sent.some((message) => message.kind === 'task.completed'),
        'socket completion'
      );
      assert.equal(client.currentState, 'open');
      assert.deepEqual(await readdir(outboxPath), []);
    } finally {
      client.disconnect();
      await rm(outboxPath, { recursive: true, force: true });
    }
  });

  it('keeps an ENOSPC completion terminal, prevents same-peer reexecution, and retries after storage recovery', async () => {
    const outboxPath = await mkdtemp(join(tmpdir(), 'orgx-receipt-enospc-'));
    const socket = new FakeSocket();
    const requests = [];
    let storageRecovered = false;
    let httpRecovered = false;
    let executions = 0;
    const raw = {
      id: 'deepseek_harness',
      async *dispatch(_task, context) {
        executions += 1;
        yield {
          kind: 'task.started',
          run_id: context.run_id,
          started_at: '2026-08-14T12:00:00.000Z',
        };
        yield completion(context.run_id);
      },
      async detect() {},
      async probe() {},
      async cancel() {},
    };
    const outbox = new TerminalReceiptOutbox({
      baseUrl: 'https://example.test',
      apiKey: 'oxk_test',
      env: { ORGX_RECEIPT_OUTBOX_PATH: outboxPath },
      persistReceipt: async (...args) => {
        if (!storageRecovered) {
          const error = new Error('disk full');
          error.code = 'ENOSPC';
          throw error;
        }
        return persistReceiptEntry(...args);
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return { status: httpRecovered ? 200 : 503 };
      },
      logger: { warn() {} },
    });
    await outbox.prepare();
    const client = new PeerClient({
      baseUrl: 'wss://example.test',
      apiKey: 'oxk_test',
      workspaceId: 'workspace-1',
      pluginId: 'orgx-deepseek-harness-plugin',
      protocolVersion: 1,
      drivers: [new ReceiptOutboxDriver(raw, outbox)],
      reconnect: false,
      webSocketFactory: () => socket,
    });
    const dispatch = {
      kind: 'task.dispatch',
      run_id: 'run-enospc',
      idempotency_key: 'dispatch-enospc',
      timeout_seconds: 30,
      task: { title: 'Run once', driver: 'deepseek_harness' },
    };
    try {
      client.connect();
      socket.emit('open');
      socket.emit('message', { data: JSON.stringify(dispatch) });
      await waitFor(
        () => socket.sent.some((message) => message.kind === 'task.completed'),
        'terminal completion despite ENOSPC'
      );
      assert.equal(executions, 1);
      assert.equal(requests.length, 1);
      assert.equal(
        socket.sent.some((message) => message.kind === 'task.failed'),
        false
      );

      socket.emit('message', { data: JSON.stringify(dispatch) });
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      assert.equal(executions, 1);

      storageRecovered = true;
      httpRecovered = true;
      assert.deepEqual(await outbox.replay(), { delivered: 1, retained: 0 });
      assert.equal(requests.length, 2);
      assert.equal(
        JSON.parse(requests[1].init.body).outcome_kind,
        'awaiting_review'
      );
      assert.deepEqual(await readdir(outboxPath), []);
    } finally {
      client.disconnect();
      await rm(outboxPath, { recursive: true, force: true });
    }
  });
});

function failingDriver() {
  return {
    id: 'deepseek_harness',
    async *dispatch(_task, context) {
      yield {
        kind: 'task.started',
        run_id: context.run_id,
        started_at: '2026-08-14T12:00:00.000Z',
      };
      yield {
        kind: 'task.failed',
        run_id: context.run_id,
        reason: 'provider failed',
        recoverable: false,
      };
    },
    async detect() {},
    async probe() {},
    async cancel() {},
  };
}

function completion(runId) {
  return {
    kind: 'task.completed',
    run_id: runId,
    outcome_kind: 'awaiting_review',
    started_at: '2026-08-14T12:00:00.000Z',
    completed_at: '2026-08-14T12:01:00.000Z',
    tokens_used: 0,
    provider: 'other',
    source_sub_type: 'api_key',
    source_driver: 'deepseek_harness',
    cost_estimate_cents: 0,
  };
}

class FakeSocket {
  listeners = new Map();
  sent = [];
  failOnCompletion = false;

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data) {
    const message = JSON.parse(data);
    if (this.failOnCompletion && message.kind === 'task.completed') {
      this.emit('close', { code: 1006, reason: 'network lost' });
      throw new Error('socket dropped');
    }
    this.sent.push(message);
  }

  close(code = 1000, reason = '') {
    this.emit('close', { code, reason });
  }
}

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}
