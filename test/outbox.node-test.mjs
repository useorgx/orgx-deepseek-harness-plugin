import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  ReceiptOutboxDriver,
  TerminalReceiptOutbox,
} from '../lib/peer/ReceiptOutbox.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('terminal receipt outbox', () => {
  it('retains a restrictive credential-free atomic entry after failed POST and removes it after replayed 2xx', async () => {
    const root = await temporaryOutbox();
    const requests = [];
    let status = 503;
    const outbox = new TerminalReceiptOutbox({
      baseUrl: 'https://example.test',
      apiKey: 'oxk_secret_must_not_persist',
      env: { ORGX_RECEIPT_OUTBOX_PATH: root },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return { status };
      },
      logger: { warn() {} },
    });
    await outbox.prepare();

    const first = await outbox.deliver(completion('run-retained'));
    assert.equal(first.delivered, false);
    const files = await readdir(root);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/);
    const path = join(root, files[0]);
    const persisted = await readFile(path, 'utf8');
    assert.doesNotMatch(persisted, /oxk_secret_must_not_persist/);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    status = 204;
    const replay = await outbox.replay();
    assert.deepEqual(replay, { delivered: 1, retained: 0 });
    assert.deepEqual(await readdir(root), []);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].init.headers['Idempotency-Key'], 'run-retained');
    assert.equal(
      JSON.parse(requests[1].init.body).outcome_kind,
      'awaiting_review'
    );
  });

  it('accepts duplicate 200 recovery and leaves no pending entry', async () => {
    const root = await temporaryOutbox();
    let requests = 0;
    const outbox = new TerminalReceiptOutbox({
      baseUrl: 'https://example.test',
      apiKey: 'oxk_test',
      env: { ORGX_RECEIPT_OUTBOX_PATH: root },
      fetch: async () => {
        requests += 1;
        return { status: 200 };
      },
      logger: { warn() {} },
    });
    await outbox.prepare();

    assert.equal(
      (await outbox.deliver(completion('run-duplicate'))).delivered,
      true
    );
    assert.equal(
      (await outbox.deliver(completion('run-duplicate'))).delivered,
      true
    );
    assert.equal(requests, 2);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(await outbox.replay(), { delivered: 0, retained: 0 });
  });

  it('requires an absolute configured path', () => {
    assert.throws(
      () =>
        new TerminalReceiptOutbox({
          baseUrl: 'https://example.test',
          apiKey: 'oxk_test',
          env: { ORGX_RECEIPT_OUTBOX_PATH: 'relative/outbox' },
        }),
      /must be absolute/
    );
  });

  it('fails restart closed when a pre-start reservation has no durable terminal', async () => {
    const root = await temporaryOutbox();
    const options = {
      baseUrl: 'https://example.test',
      apiKey: 'oxk_test',
      env: { ORGX_RECEIPT_OUTBOX_PATH: root },
      fetch: async () => ({ status: 503 }),
      logger: { warn() {} },
    };
    const firstProcess = new TerminalReceiptOutbox(options);
    await firstProcess.prepare();
    await firstProcess.reserve({
      kind: 'task.started',
      run_id: 'run-unresolved',
      started_at: '2026-08-14T12:00:00.000Z',
    });

    const restarted = new TerminalReceiptOutbox(options);
    await assert.rejects(
      restarted.prepare(),
      /unresolved reservation for run run-unresolved; repair or reconcile ORGX_RECEIPT_OUTBOX_PATH/
    );
  });

  it('persists and attempts HTTP delivery before yielding the socket terminal', async () => {
    let release;
    let delivered = false;
    const delivery = new Promise((resolvePromise) => {
      release = () => {
        delivered = true;
        resolvePromise();
      };
    });
    const driver = new ReceiptOutboxDriver(
      {
        id: 'deepseek_harness',
        async *dispatch(_task, context) {
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
      },
      {
        reserve: async () => {},
        deliver: async () => delivery,
        retain() {},
        recoverWithoutReservation: async () => false,
      }
    );
    const iterator = driver.dispatch(
      { title: 'Wait for receipt' },
      { run_id: 'run-order', idempotency_key: 'dispatch-order' }
    );
    assert.equal((await iterator.next()).value.kind, 'task.started');
    let terminalSettled = false;
    const terminal = iterator.next().then((value) => {
      terminalSettled = true;
      return value;
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(terminalSettled, false);
    release();
    assert.equal((await terminal).value.kind, 'task.completed');
    assert.equal(delivered, true);
  });

  it('does not start execution when the durable pre-start reservation fails', async () => {
    const root = await temporaryOutbox();
    const requests = [];
    let executionStarted = false;
    const error = new Error('disk full');
    error.code = 'ENOSPC';
    const outbox = new TerminalReceiptOutbox({
      baseUrl: 'https://example.test',
      apiKey: 'oxk_test',
      env: { ORGX_RECEIPT_OUTBOX_PATH: root },
      persistReservation: async () => {
        throw error;
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return { status: 200 };
      },
      logger: { warn() {} },
    });
    await outbox.prepare();
    const driver = new ReceiptOutboxDriver(
      {
        id: 'deepseek_harness',
        async *dispatch(_task, context) {
          yield {
            kind: 'task.started',
            run_id: context.run_id,
            started_at: '2026-08-14T12:00:00.000Z',
          };
          executionStarted = true;
          yield completion(context.run_id);
        },
        async detect() {},
        async probe() {},
        async cancel() {},
      },
      outbox
    );
    const messages = [];
    for await (const message of driver.dispatch(
      { title: 'Must not execute' },
      { run_id: 'run-reservation-failed', idempotency_key: 'dispatch-reserve' }
    )) {
      messages.push(message);
    }

    assert.equal(executionStarted, false);
    assert.deepEqual(
      messages.map((message) => message.kind),
      ['task.completed']
    );
    assert.equal(messages[0].outcome_kind, 'blocked');
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].init.body).outcome_kind, 'blocked');
  });

  it('recovers ENOSPC immediately over HTTP, yields the original completion, and clears the restart marker', async () => {
    const root = await temporaryOutbox();
    let executions = 0;
    const requests = [];
    const diskFull = new Error('disk full');
    diskFull.code = 'ENOSPC';
    const options = {
      baseUrl: 'https://example.test',
      apiKey: 'oxk_test',
      env: { ORGX_RECEIPT_OUTBOX_PATH: root },
      persistReceipt: async () => {
        throw diskFull;
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return { status: 200 };
      },
      logger: { warn() {} },
    };
    const outbox = new TerminalReceiptOutbox(options);
    await outbox.prepare();
    const expected = completion('run-enospc-http');
    const driver = new ReceiptOutboxDriver(
      {
        id: 'deepseek_harness',
        async *dispatch(_task, context) {
          executions += 1;
          yield {
            kind: 'task.started',
            run_id: context.run_id,
            started_at: expected.started_at,
          };
          yield expected;
        },
        async detect() {},
        async probe() {},
        async cancel() {},
      },
      outbox
    );
    const messages = [];
    for await (const message of driver.dispatch(
      { title: 'Complete once' },
      { run_id: expected.run_id, idempotency_key: 'dispatch-enospc-http' }
    )) {
      messages.push(message);
    }

    assert.equal(executions, 1);
    assert.equal(requests.length, 1);
    assert.equal(messages.at(-1), expected);
    assert.deepEqual(await readdir(root), []);
    const restarted = new TerminalReceiptOutbox(options);
    await restarted.prepare();
  });

  it('still yields the original terminal when both storage and immediate recovery fail', async () => {
    const expected = completion('run-double-recovery-failure');
    const retained = [];
    const driver = new ReceiptOutboxDriver(
      {
        id: 'deepseek_harness',
        async *dispatch() {
          yield {
            kind: 'task.started',
            run_id: expected.run_id,
            started_at: expected.started_at,
          };
          yield expected;
        },
        async detect() {},
        async probe() {},
        async cancel() {},
      },
      {
        reserve: async () => {},
        deliver: async () => {
          throw new Error('receipt storage unavailable');
        },
        retain: (message) => retained.push(message),
        recoverWithoutReservation: async () => {
          throw new Error('receipt endpoint unavailable');
        },
      }
    );

    const messages = [];
    for await (const message of driver.dispatch(
      { title: 'Do not lose the terminal' },
      { run_id: expected.run_id, idempotency_key: 'dispatch-double-failure' }
    )) {
      messages.push(message);
    }

    assert.equal(messages.at(-1), expected);
    assert.equal(retained.length, 2);
    assert.equal(retained[0], expected);
    assert.equal(retained[1], expected);
  });
});

async function temporaryOutbox() {
  const root = await mkdtemp(join(tmpdir(), 'orgx-receipt-outbox-'));
  roots.push(root);
  return root;
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
