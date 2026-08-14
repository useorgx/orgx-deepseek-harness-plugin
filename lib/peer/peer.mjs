/**
 * OrgX Sovereign Execution peer for DeepSeek Harness.
 *
 * The gateway SDK owns socket reconnect, idempotency, cancellation routing,
 * and receipt fallback. This module owns the workspace-bound driver plus the
 * gateway-presence and package-license heartbeats.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCredentialReadinessProbe } from './CredentialReadinessProbe.mjs';
import { DeepSeekHarnessDriver } from './DeepSeekHarnessDriver.mjs';
import { DurableFailureDriver } from './DurableFailureDriver.mjs';
import {
  HOST_ACCESS_ACK_ENV,
  requireHostAccessAcknowledgment,
} from './HostAccessAcknowledgment.mjs';
import {
  ReceiptOutboxDriver,
  TerminalReceiptOutbox,
} from './ReceiptOutbox.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const PACKAGE_ID = '@useorgx/deepseek-harness-plugin';
const GATEWAY_PLUGIN_ID = 'orgx-deepseek-harness-plugin';
const DRIVER_ID = 'deepseek_harness';
const GATEWAY_PROTOCOL_VERSION = 1;
const GATEWAY_HEARTBEAT_MS = 15_000;
const LICENSE_HEARTBEAT_MS = 7 * 24 * 60 * 60 * 1000;

export async function startPeer(opts = {}) {
  const peerEnv = opts.env ?? process.env;
  const hostAccessAck = opts.hostAccessAck ?? peerEnv[HOST_ACCESS_ACK_ENV];
  requireHostAccessAcknowledgment(hostAccessAck);
  const runtimeEnv = { ...peerEnv, [HOST_ACCESS_ACK_ENV]: hostAccessAck };
  const apiKey = requiredString(opts.apiKey, 'OrgX API key');
  const workspaceId = requiredString(opts.workspaceId, 'OrgX workspace id');
  const installationId = requiredString(
    opts.installationId,
    'OrgX installation id'
  );
  if (installationId.length > 160) {
    throw new TypeError('OrgX installation id must be 160 characters or fewer');
  }
  rejectManagedRunnerOptions(opts);
  const baseUrl = requiredString(
    opts.baseUrl ?? 'https://useorgx.com',
    'OrgX base URL'
  );
  const logger = opts.logger ?? console;
  const manifest = opts.manifest ?? (await loadManifest());
  const receiptOutbox =
    opts.receiptOutbox ??
    new TerminalReceiptOutbox({
      apiKey,
      baseUrl,
      env: runtimeEnv,
      fetch: opts.fetch,
      logger,
      timeoutMs: opts.receiptTimeoutMs,
    });
  await receiptOutbox.prepare();
  await receiptOutbox.replay();
  const credentialProbe =
    opts.credentialProbe ??
    createCredentialReadinessProbe({
      env: runtimeEnv,
      fetch: opts.readinessFetch ?? opts.fetch,
      sdkLoader: opts.mcpSdkLoader,
      timeoutMs: opts.credentialProbeTimeoutMs,
      ttlMs: opts.credentialProbeTtlMs,
    });
  const driver =
    opts.driver ??
    new DeepSeekHarnessDriver({
      bin: opts.bin,
      profile: opts.profile,
      model: opts.model,
      workspaceRoot: opts.workspaceRoot,
      env: runtimeEnv,
      credentialProbe,
    });
  const durableDriver = opts.durableDriver ?? new DurableFailureDriver(driver);
  const peerDriver =
    opts.peerDriver ?? new ReceiptOutboxDriver(durableDriver, receiptOutbox);
  const PeerClientClass = opts.PeerClientClass ?? (await loadPeerClient());
  const heartbeatContext = {
    apiKey,
    workspaceId,
    installationId,
    baseUrl,
    driver,
    version: manifest.version,
    fetch: opts.fetch,
    hostPlatform: opts.hostPlatform ?? process.platform,
  };

  // Gateway admission looks up this exact installation row before accepting
  // the WebSocket upgrade. Presence is created first, with no transport or
  // dispatch claim.
  await postGatewayHeartbeat(heartbeatContext, false);

  let transportOnline = false;
  let stopping = false;
  let gatewayTimer;
  let licenseTimer;
  let heartbeatChain = Promise.resolve();
  const queueGatewayHeartbeat = (online) => {
    transportOnline = online;
    const run = heartbeatChain
      .catch(() => undefined)
      .then(() => postGatewayHeartbeat(heartbeatContext, transportOnline));
    heartbeatChain = run;
    void run.catch((error) =>
      logger.warn?.('[orgx-deepseek-harness] gateway heartbeat failed', error)
    );
    return run;
  };
  const replayReceiptOutbox = () =>
    Promise.resolve(receiptOutbox.replay()).catch((error) =>
      logger.warn?.(
        '[orgx-deepseek-harness] receipt outbox replay failed',
        error
      )
    );

  const client = new PeerClientClass({
    baseUrl: httpsToWss(baseUrl),
    apiKey,
    workspaceId,
    pluginId: GATEWAY_PLUGIN_ID,
    installationId,
    drivers: [peerDriver],
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    fetch: opts.fetch,
    ...(opts.webSocketFactory
      ? { webSocketFactory: opts.webSocketFactory }
      : {}),
    ...(opts.reconnect !== undefined ? { reconnect: opts.reconnect } : {}),
    onOpen: () => {
      transportOnline = true;
      logger.log?.('[orgx-deepseek-harness] gateway connected');
      void replayReceiptOutbox();
      void queueGatewayHeartbeat(true);
    },
    onClose: (code, reason) => {
      transportOnline = false;
      logger.warn?.('[orgx-deepseek-harness] gateway closed', { code, reason });
      if (!stopping) void queueGatewayHeartbeat(false);
    },
    onError: (error) =>
      logger.error?.('[orgx-deepseek-harness] gateway error', error),
  });

  if (!opts.skipLicenseHeartbeat) {
    const licenseHeartbeat = () =>
      postLicenseHeartbeat(
        baseUrl,
        { apiKey, workspaceId, fetch: opts.fetch },
        manifest
      ).catch((error) =>
        logger.warn?.('[orgx-deepseek-harness] license heartbeat failed', error)
      );
    await licenseHeartbeat();
    const schedule = opts.setInterval ?? globalThis.setInterval;
    licenseTimer = schedule(licenseHeartbeat, LICENSE_HEARTBEAT_MS);
    licenseTimer?.unref?.();
  }

  client.connect();
  const schedule = opts.setInterval ?? globalThis.setInterval;
  gatewayTimer = schedule(() => {
    void replayReceiptOutbox();
    void queueGatewayHeartbeat(transportOnline);
  }, GATEWAY_HEARTBEAT_MS);
  gatewayTimer?.unref?.();

  return {
    client,
    driver,
    peerDriver,
    receiptOutbox,
    flushHeartbeat: () => heartbeatChain.catch(() => undefined),
    stop: async () => {
      if (stopping) return;
      stopping = true;
      const cancel = opts.clearInterval ?? globalThis.clearInterval;
      if (gatewayTimer) cancel(gatewayTimer);
      if (licenseTimer) cancel(licenseTimer);
      transportOnline = false;
      await Promise.resolve(client.disconnect());
      await queueGatewayHeartbeat(false).catch(() => undefined);
      await Promise.resolve(receiptOutbox.flush()).catch(() => undefined);
    },
  };
}

async function driverReadiness(driver) {
  const [detected, probed] = await Promise.all([
    Promise.resolve()
      .then(() => driver.detect())
      .catch((error) => ({
        installed: false,
        authenticated: false,
        subscription_active: false,
        error: error instanceof Error ? error.message : String(error),
      })),
    Promise.resolve()
      .then(() => driver.probe())
      .catch(() => ({
        subscription_active: false,
        session_alive: false,
        queue_depth: 0,
      })),
  ]);
  const runtimeOnline =
    detected.installed === true && probed.session_alive === true;
  const authenticated =
    probed.authenticated === true &&
    probed.provider_authenticated === true &&
    probed.mcp_authenticated === true;
  const subscriptionActive =
    runtimeOnline && authenticated && probed.subscription_active === true;
  const authStatus = !runtimeOnline
    ? 'probe_failed'
    : authenticated
    ? 'authenticated'
    : typeof probed.auth_status === 'string' && probed.auth_status.trim()
    ? probed.auth_status.trim()
    : 'credentials_unverified';
  return {
    runtimeOnline,
    authenticated,
    subscriptionActive,
    authStatus,
    version:
      typeof detected.version === 'string' ? detected.version : undefined,
    queueDepth:
      typeof probed.queue_depth === 'number' &&
      Number.isFinite(probed.queue_depth)
        ? probed.queue_depth
        : 0,
  };
}

async function postGatewayHeartbeat(context, transportOnline) {
  const readiness = await driverReadiness(context.driver);
  const dispatchReady =
    transportOnline && readiness.runtimeOnline && readiness.authenticated;
  return postJson(
    `${context.baseUrl.replace(/\/$/, '')}/api/v1/gateway/heartbeat`,
    context.apiKey,
    {
      workspace_id: context.workspaceId,
      plugin_id: GATEWAY_PLUGIN_ID,
      installation_id: context.installationId,
      host_platform: context.hostPlatform,
      drivers_installed: [DRIVER_ID],
      gateway_version: context.version,
      protocol_version: GATEWAY_PROTOCOL_VERSION,
      subscription_active: readiness.subscriptionActive,
      metadata: {
        runtime: 'deepseek-harness',
        runtime_online: readiness.runtimeOnline,
        transport_online: transportOnline,
        dispatch_ready: dispatchReady,
        auth_status: readiness.authStatus,
        durable_receipt_outbox: true,
        ...(readiness.version ? { probe_version: readiness.version } : {}),
        queue_depth: readiness.queueDepth,
      },
    },
    context.fetch,
    'gateway heartbeat'
  );
}

async function loadPeerClient() {
  const sdk = await import('@useorgx/orgx-gateway-sdk');
  if (typeof sdk.PeerClient !== 'function') {
    throw new Error('@useorgx/orgx-gateway-sdk does not export PeerClient');
  }
  return sdk.PeerClient;
}

async function loadManifest() {
  const path = resolve(PLUGIN_ROOT, 'plugin.manifest.json');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function postLicenseHeartbeat(baseUrl, opts, manifest) {
  return postJson(
    `${baseUrl.replace(/\/$/, '')}/api/v1/licenses/heartbeat`,
    opts.apiKey,
    {
      workspace_id: opts.workspaceId,
      plugin_name: manifest.plugin_name,
      version: manifest.version,
      manifest_fingerprint: manifest.manifest_fingerprint,
      signature: manifest.signature,
    },
    opts.fetch,
    'license heartbeat'
  );
}

async function postJson(url, apiKey, body, fetchOverride, label) {
  const request = fetchOverride ?? globalThis.fetch;
  if (typeof request !== 'function')
    throw new Error(`fetch is required for the OrgX ${label}`);
  const response = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${label} ${response.status}`);
}

function httpsToWss(value) {
  if (value.startsWith('https://'))
    return `wss://${value.slice('https://'.length)}`;
  if (value.startsWith('http://'))
    return `ws://${value.slice('http://'.length)}`;
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function rejectManagedRunnerOptions(input) {
  const supplied = [
    ['ORGX_RUNNER_INSTANCE_ID', input.runnerInstanceId],
    ['ORGX_ACTIVATION_ATTEMPT_ID', input.activationAttemptId],
    ['ORGX_RUNNER_ROLE', input.runnerRole],
  ]
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([name]) => name);
  if (supplied.length > 0) {
    throw new TypeError(
      `${supplied.join(
        ', '
      )} cannot be used: this developer preview supports only unmanaged gateway protocol v1`
    );
  }
}

export {
  DRIVER_ID,
  GATEWAY_HEARTBEAT_MS,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_PLUGIN_ID,
  LICENSE_HEARTBEAT_MS,
  PACKAGE_ID,
  PLUGIN_ROOT,
  driverReadiness,
  httpsToWss,
  loadManifest,
  postGatewayHeartbeat,
  postLicenseHeartbeat,
  rejectManagedRunnerOptions,
};
