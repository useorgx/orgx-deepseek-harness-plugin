import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { TerminalReceiptOutbox } from '../lib/peer/ReceiptOutbox.mjs';

import {
  GATEWAY_HEARTBEAT_MS,
  GATEWAY_PLUGIN_ID,
  PACKAGE_ID,
  httpsToWss,
  startPeer,
} from '../lib/peer/peer.mjs';

class FakePeerClient {
  static instances = [];

  constructor(config) {
    this.config = config;
    this.connected = false;
    this.disconnected = false;
    FakePeerClient.instances.push(this);
  }

  connect() {
    this.connected = true;
    this.config.onOpen?.();
  }

  disconnect() {
    this.disconnected = true;
    this.config.onClose?.(1000, 'client closing');
  }
}

const silentLogger = { log() {}, warn() {}, error() {} };
function fakeOutbox() {
  return {
    prepareCalls: 0,
    replayCalls: 0,
    flushCalls: 0,
    async prepare() {
      this.prepareCalls += 1;
    },
    async replay() {
      this.replayCalls += 1;
      return { delivered: 0, retained: 0 };
    },
    async deliver() {},
    async flush() {
      this.flushCalls += 1;
    },
  };
}
const readyDriver = {
  id: 'deepseek_harness',
  detect: async () => ({
    installed: true,
    authenticated: false,
    subscription_active: false,
    version: 'dsh 0.1.0-rc.6',
  }),
  probe: async () => ({
    authenticated: true,
    provider_authenticated: true,
    mcp_authenticated: true,
    subscription_active: true,
    auth_status: 'authenticated',
    session_alive: true,
    queue_depth: 2,
  }),
  async *dispatch() {},
  async cancel() {},
};

function heartbeatRequests(requests) {
  return requests.filter(({ url }) =>
    url.endsWith('/api/v1/gateway/heartbeat')
  );
}

describe('DeepSeek Harness OrgX peer', () => {
  it('requires explicit host-access acknowledgement before peer startup', async () => {
    await assert.rejects(
      startPeer({
        apiKey: 'oxk_test',
        workspaceId: 'workspace-1',
        installationId: 'install-1',
      }),
      /ORGX_DEEPSEEK_HOST_ACCESS_ACK=1 is required/
    );
  });

  it('creates unmanaged v1 presence before connect and tracks transport readiness', async () => {
    const requests = [];
    const intervals = [];
    const receiptOutbox = fakeOutbox();
    const peer = await startPeer({
      hostAccessAck: '1',
      apiKey: 'oxk_test',
      workspaceId: 'workspace-1',
      installationId: 'install.deepseek-1',
      baseUrl: 'https://example.test',
      driver: readyDriver,
      receiptOutbox,
      PeerClientClass: FakePeerClient,
      manifest: {
        plugin_name: PACKAGE_ID,
        version: '0.1.0',
        manifest_fingerprint: '',
        signature: '',
      },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, status: 200 };
      },
      setInterval: (callback, milliseconds) => {
        const handle = { callback, milliseconds, cleared: false, unref() {} };
        intervals.push(handle);
        return handle;
      },
      clearInterval: (handle) => {
        handle.cleared = true;
      },
      logger: silentLogger,
      hostPlatform: 'test-platform',
    });
    await peer.flushHeartbeat();

    const client = FakePeerClient.instances.at(-1);
    assert.equal(client.connected, true);
    assert.equal(client.config.baseUrl, 'wss://example.test');
    assert.equal(client.config.pluginId, GATEWAY_PLUGIN_ID);
    assert.equal(client.config.installationId, 'install.deepseek-1');
    assert.equal(client.config.runnerInstanceId, undefined);
    assert.equal(client.config.protocolVersion, 1);
    assert.equal(client.config.drivers.length, 1);
    assert.equal(client.config.drivers[0].inner.inner, readyDriver);

    const gateway = heartbeatRequests(requests);
    assert.equal(gateway.length, 2);
    const preconnect = JSON.parse(gateway[0].init.body);
    assert.deepEqual(
      {
        plugin_id: preconnect.plugin_id,
        installation_id: preconnect.installation_id,
        drivers_installed: preconnect.drivers_installed,
        protocol_version: preconnect.protocol_version,
        subscription_active: preconnect.subscription_active,
        runtime_online: preconnect.metadata.runtime_online,
        transport_online: preconnect.metadata.transport_online,
        dispatch_ready: preconnect.metadata.dispatch_ready,
        auth_status: preconnect.metadata.auth_status,
      },
      {
        plugin_id: GATEWAY_PLUGIN_ID,
        installation_id: 'install.deepseek-1',
        drivers_installed: ['deepseek_harness'],
        protocol_version: 1,
        subscription_active: true,
        runtime_online: true,
        transport_online: false,
        dispatch_ready: false,
        auth_status: 'authenticated',
      }
    );
    assert.equal('runner_instance_id' in preconnect, false);
    assert.equal('activation_attempt_id' in preconnect, false);
    assert.equal('runner_role' in preconnect, false);
    const online = JSON.parse(gateway[1].init.body);
    assert.equal(online.metadata.transport_online, true);
    assert.equal(online.metadata.dispatch_ready, true);
    assert.equal(online.metadata.queue_depth, 2);
    assert.equal(online.host_platform, 'test-platform');

    const license = requests.find(({ url }) =>
      url.endsWith('/api/v1/licenses/heartbeat')
    );
    assert.ok(license);
    assert.equal(license.init.headers.Authorization, 'Bearer oxk_test');
    assert.equal(JSON.parse(license.init.body).plugin_name, PACKAGE_ID);

    const gatewayInterval = intervals.find(
      ({ milliseconds }) => milliseconds === GATEWAY_HEARTBEAT_MS
    );
    assert.ok(gatewayInterval);
    gatewayInterval.callback();
    await peer.flushHeartbeat();
    assert.equal(heartbeatRequests(requests).length, 3);
    assert.equal(
      JSON.parse(heartbeatRequests(requests).at(-1).init.body).metadata
        .dispatch_ready,
      true
    );
    assert.equal(receiptOutbox.replayCalls, 3);

    client.config.onClose(1006, 'network lost');
    await peer.flushHeartbeat();
    const offline = JSON.parse(heartbeatRequests(requests).at(-1).init.body);
    assert.equal(offline.metadata.transport_online, false);
    assert.equal(offline.metadata.dispatch_ready, false);

    await peer.stop();
    assert.equal(client.disconnected, true);
    assert.equal(receiptOutbox.flushCalls, 1);
    assert.ok(intervals.every((handle) => handle.cleared));
  });

  it('keeps dispatch closed when the DeepSeek credential probe is not authenticated', async () => {
    const requests = [];
    const handles = [];
    const peer = await startPeer({
      hostAccessAck: '1',
      apiKey: 'oxk_test',
      workspaceId: 'workspace-1',
      installationId: 'install.deepseek-no-auth',
      driver: {
        id: 'deepseek_harness',
        detect: async () => ({ installed: true, authenticated: false }),
        probe: async () => ({
          authenticated: false,
          provider_authenticated: false,
          mcp_authenticated: false,
          session_alive: true,
          subscription_active: false,
          auth_status: 'provider_auth_rejected',
        }),
        async *dispatch() {},
        async cancel() {},
      },
      receiptOutbox: fakeOutbox(),
      PeerClientClass: FakePeerClient,
      manifest: {
        plugin_name: PACKAGE_ID,
        version: '0.1.0',
        manifest_fingerprint: '',
        signature: '',
      },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, status: 200 };
      },
      setInterval: (callback, milliseconds) => {
        const handle = { callback, milliseconds, unref() {} };
        handles.push(handle);
        return handle;
      },
      clearInterval() {},
      skipLicenseHeartbeat: true,
      logger: silentLogger,
    });
    await peer.flushHeartbeat();
    const online = JSON.parse(heartbeatRequests(requests).at(-1).init.body);
    assert.equal(online.metadata.transport_online, true);
    assert.equal(online.metadata.runtime_online, true);
    assert.equal(online.metadata.auth_status, 'provider_auth_rejected');
    assert.equal(online.metadata.dispatch_ready, false);
    assert.equal(online.subscription_active, false);
    await peer.stop();
  });

  it('replays a retained HTTP receipt on the periodic tick without a reconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orgx-peer-periodic-outbox-'));
    const intervals = [];
    let status = 503;
    let receiptRequests = 0;
    const outbox = new TerminalReceiptOutbox({
      baseUrl: 'https://example.test',
      apiKey: 'oxk_test',
      env: { ORGX_RECEIPT_OUTBOX_PATH: root },
      fetch: async () => {
        receiptRequests += 1;
        return { status };
      },
      logger: silentLogger,
    });
    await outbox.prepare();
    await outbox.deliver({
      kind: 'task.completed',
      run_id: 'run-periodic-replay',
      outcome_kind: 'awaiting_review',
      started_at: '2026-08-14T12:00:00.000Z',
      completed_at: '2026-08-14T12:01:00.000Z',
      tokens_used: 0,
      provider: 'other',
      source_sub_type: 'api_key',
      source_driver: 'deepseek_harness',
      cost_estimate_cents: 0,
    });
    const peer = await startPeer({
      hostAccessAck: '1',
      apiKey: 'oxk_test',
      workspaceId: 'workspace-1',
      installationId: 'install.periodic',
      driver: readyDriver,
      receiptOutbox: outbox,
      PeerClientClass: FakePeerClient,
      manifest: {
        plugin_name: PACKAGE_ID,
        version: '0.1.0',
        manifest_fingerprint: '',
        signature: '',
      },
      fetch: async () => ({ ok: true, status: 200 }),
      setInterval: (callback, milliseconds) => {
        const handle = { callback, milliseconds, unref() {} };
        intervals.push(handle);
        return handle;
      },
      clearInterval() {},
      skipLicenseHeartbeat: true,
      logger: silentLogger,
    });
    try {
      await outbox.flush();
      assert.equal((await readdir(root)).length, 1);
      const requestsBeforeTick = receiptRequests;
      status = 200;
      intervals
        .find(({ milliseconds }) => milliseconds === GATEWAY_HEARTBEAT_MS)
        .callback();
      await outbox.flush();
      assert.equal(receiptRequests, requestsBeforeTick + 1);
      assert.deepEqual(await readdir(root), []);
    } finally {
      await peer.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when any gateway identity field is missing', async () => {
    await assert.rejects(
      startPeer({
        hostAccessAck: '1',
        apiKey: '',
        workspaceId: 'workspace-1',
        installationId: 'install-1',
      }),
      /OrgX API key/
    );
    await assert.rejects(
      startPeer({
        hostAccessAck: '1',
        apiKey: 'oxk_test',
        workspaceId: '',
        installationId: 'install-1',
      }),
      /OrgX workspace id/
    );
    await assert.rejects(
      startPeer({
        hostAccessAck: '1',
        apiKey: 'oxk_test',
        workspaceId: 'workspace-1',
        installationId: '',
      }),
      /OrgX installation id/
    );
    await assert.rejects(
      startPeer({
        hostAccessAck: '1',
        apiKey: 'oxk_test',
        workspaceId: 'workspace-1',
        installationId: 'x'.repeat(161),
      }),
      /160 characters/
    );
  });

  it('rejects managed runner fields instead of advertising invalid v1/v3 support', async () => {
    for (const extra of [
      { runnerInstanceId: 'candidate.act.12345678' },
      { activationAttemptId: 'act.12345678' },
      { runnerRole: 'candidate' },
    ]) {
      await assert.rejects(
        startPeer({
          hostAccessAck: '1',
          apiKey: 'oxk_test',
          workspaceId: 'workspace-1',
          installationId: 'install-1',
          ...extra,
        }),
        /supports only unmanaged gateway protocol v1/
      );
    }
  });

  it('maps HTTP gateway URLs to WebSocket URLs', () => {
    assert.equal(httpsToWss('https://useorgx.com'), 'wss://useorgx.com');
    assert.equal(httpsToWss('http://localhost:3000'), 'ws://localhost:3000');
  });
});
