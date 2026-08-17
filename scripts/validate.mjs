#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let checks = 0;

const check = (condition, message) => {
  checks += 1;
  assert.ok(condition, message);
};
const read = (path) => readFile(resolve(ROOT, path), 'utf8');
const json = async (path) => JSON.parse(await read(path));
const includesAll = (source, values, label) => {
  for (const value of values) {
    check(source.includes(value), `${label} is missing ${value}`);
  }
};

const packageManifest = await json('package.json');
check(
  packageManifest.name === '@useorgx/deepseek-harness-plugin',
  'package name drifted'
);
check(packageManifest.version === '0.1.0', 'package version must remain 0.1.0');
check(packageManifest.private === false, 'package must remain publicly publishable');
check(
  packageManifest.publishConfig?.access === 'public',
  'package publish access must remain public'
);
check(packageManifest.license === 'MIT', 'package license must remain MIT');
check(
  packageManifest.repository?.url ===
    'git+https://github.com/useorgx/orgx-deepseek-harness-plugin.git',
  'package must point at the public plugin repository'
);
check(
  packageManifest.dsh?.bundle?.patch === './cordis.patch.yml',
  'dsh.bundle.patch must reference cordis.patch.yml'
);
check(
  packageManifest.dependencies?.['@deepseek-ai/dsh-mcp-client'] ===
    '0.1.0-rc.6',
  'DSH MCP client must be pinned to 0.1.0-rc.6'
);
check(
  packageManifest.dependencies?.['@modelcontextprotocol/sdk'] === '1.29.0',
  'MCP SDK must be pinned to 1.29.0'
);
check(
  packageManifest.dependencies?.['@useorgx/orgx-gateway-sdk'] === undefined,
  'OrgX gateway SDK must stay vendored so DSH can install with exotic subdependencies blocked'
);
check(
  packageManifest.files?.includes('THIRD_PARTY_NOTICES.md'),
  'package files must include third-party notices'
);
check(packageManifest.files?.includes('LICENSE'), 'package files must include the MIT license');
check(
  packageManifest.scripts?.test === 'node --test test/*.node-test.mjs',
  'package tests must use the Node-only *.node-test.mjs suffix'
);
const testModules = (await readdir(resolve(ROOT, 'test'))).filter((file) =>
  file.endsWith('.mjs')
);
check(testModules.length > 0, 'package test suite must not be empty');
check(
  testModules.every((file) => file.endsWith('.node-test.mjs')),
  'package test modules must stay outside root Vitest discovery'
);

const bundle = await read('cordis.patch.yml');
includesAll(
  bundle,
  [
    "name: '@deepseek-ai/dsh-mcp-client'",
    'serverName: orgx',
    'transport: streamable-http',
    'https://mcp.useorgx.com/mcp',
    'ORGX_MCP_URL',
    'ORGX_MCP_ACCESS_TOKEN',
    'Authorization:',
    'Bearer ${token}',
    'failOnStartupError: true',
    "throw new Error('ORGX_MCP_ACCESS_TOKEN is required",
  ],
  'cordis.patch.yml'
);
check(
  !/oxk_[A-Za-z0-9_-]{8,}/.test(bundle),
  'cordis.patch.yml contains an API key literal'
);

const modelPatch = await read('model.patch.yml');
includesAll(
  modelPatch,
  [
    'id: agent-default-model',
    'provider: deepseek-official',
    'ORGX_DEEPSEEK_HARNESS_MODEL',
    'throw new Error',
  ],
  'model.patch.yml'
);

const pluginManifest = await json('plugin.manifest.json');
check(
  pluginManifest.plugin_name === packageManifest.name,
  'plugin name must match package name'
);
check(
  pluginManifest.version === packageManifest.version,
  'plugin version must match package version'
);
check(
  pluginManifest.driver_ids?.length === 1 &&
    pluginManifest.driver_ids[0] === 'deepseek_harness',
  'plugin manifest must declare only deepseek_harness'
);
check(
  pluginManifest.capabilities?.includes('gateway:drive'),
  'gateway:drive capability is required'
);
check(
  pluginManifest.capabilities?.includes('plugin:heartbeat'),
  'plugin:heartbeat capability is required'
);
check(
  pluginManifest.signature === '',
  'developer-preview manifest must remain unsigned'
);

const driver = await read('lib/peer/DeepSeekHarnessDriver.mjs');
includesAll(
  driver,
  [
    "id = 'deepseek_harness'",
    "outcome_kind: 'awaiting_review'",
    "provider: 'other'",
    "source_sub_type: 'api_key'",
    "source_driver: 'deepseek_harness'",
    'tokens_used: 0',
    'cost_estimate_cents: 0',
    'resolveWorkspace',
    'realpath',
    'buildHarnessChildEnv',
    'buildHarnessProbeEnv',
    "childEnv.DSH_PERMISSION_MODE = 'workspace-write'",
    "childEnv.DSH_TELEMETRY_DISABLED = '1'",
    'terminationRequested',
    'requireHostAccessAcknowledgment',
    "AUDITED_DSH_VERSION = '0.1.0-rc.6'",
    "auth_status: 'unsupported_version'",
  ],
  'DeepSeekHarnessDriver.mjs'
);
check(
  !driver.includes('const childEnv = { ...this.env'),
  'driver must not inherit the gateway environment'
);
check(
  !driver.includes("name.startsWith('DSH_')"),
  'driver must not forward wildcard DSH controls'
);

const readiness = await read('lib/peer/CredentialReadinessProbe.mjs');
includesAll(
  readiness,
  [
    'user/balance',
    'is_available === true',
    'StreamableHTTPClientTransport',
    'client.listTools',
    'provider_authenticated',
    'mcp_authenticated',
    'DEFAULT_PROBE_TTL_MS = 45_000',
    'baseUrl: DEFAULT_DEEPSEEK_BASE_URL',
    'requireHostAccessAcknowledgment',
  ],
  'CredentialReadinessProbe.mjs'
);

const durableFailure = await read('lib/peer/DurableFailureDriver.mjs');
includesAll(
  durableFailure,
  [
    'class DurableFailureDriver',
    "? 'abandoned' : 'blocked'",
    'outcome_kind: outcomeKind',
    "kind: 'task.completed'",
    "kind: 'task.step'",
  ],
  'DurableFailureDriver.mjs'
);

const outbox = await read('lib/peer/ReceiptOutbox.mjs');
includesAll(
  outbox,
  [
    'class TerminalReceiptOutbox',
    'class ReceiptOutboxDriver',
    'deepseek_harness_receipt_outbox',
    'Idempotency-Key',
    'status >= 200 && status < 300',
    'pendingMemory',
    'this.outbox.reserve(message)',
    'recoverWithoutReservation',
    'Never replace an already-produced completion',
  ],
  'ReceiptOutbox.mjs'
);
const outboxStorage = await read('lib/peer/ReceiptOutboxStorage.mjs');
includesAll(
  outboxStorage,
  [
    'ORGX_RECEIPT_OUTBOX_PATH',
    'mode: 0o600',
    'chmod(directory, 0o700)',
    'auditUnresolvedReservations',
    'unresolved reservation for run',
    '.reservation.json',
  ],
  'ReceiptOutboxStorage.mjs'
);

const peer = await read('lib/peer/peer.mjs');
includesAll(
  peer,
  [
    "import('./vendor/OrgXGatewayPeerClient.mjs')",
    '/api/v1/licenses/heartbeat',
    '/api/v1/gateway/heartbeat',
    "GATEWAY_PLUGIN_ID = 'orgx-deepseek-harness-plugin'",
    'GATEWAY_HEARTBEAT_MS = 15_000',
    'GATEWAY_PROTOCOL_VERSION = 1',
    'installationId',
    'createCredentialReadinessProbe',
    'provider_authenticated === true',
    'mcp_authenticated === true',
    'rejectManagedRunnerOptions',
    'new DurableFailureDriver(driver)',
    'new ReceiptOutboxDriver(durableDriver, receiptOutbox)',
    'receiptOutbox.replay()',
    'durable_receipt_outbox: true',
    'requireHostAccessAcknowledgment',
  ],
  'peer.mjs'
);
const vendoredGatewaySdk = await read(
  'lib/peer/vendor/OrgXGatewayPeerClient.mjs'
);
includesAll(
  vendoredGatewaySdk,
  [
    '@useorgx/orgx-gateway-sdk 0.1.0-alpha.9',
    '49f3cad612954c448878dc62d0f9c6bc87fa0f79',
    'var PeerClient = class',
  ],
  'vendored OrgX gateway SDK'
);
const thirdPartyNotices = await read('THIRD_PARTY_NOTICES.md');
includesAll(
  thirdPartyNotices,
  [
    '@useorgx/orgx-gateway-sdk',
    '49f3cad612954c448878dc62d0f9c6bc87fa0f79',
    'MIT License',
    'Copyright (c) 2026 OrgX',
  ],
  'THIRD_PARTY_NOTICES.md'
);

const cliBin = await read('lib/peer/cli.mjs');
check(
  cliBin.includes("import { main } from './PeerCli.mjs'") &&
    !cliBin.includes('pathToFileURL'),
  'CLI bin must execute through symlinks without an import-url guard'
);
const cli = await read('lib/peer/PeerCli.mjs');
includesAll(
  cli,
  [
    'ORGX_INSTALLATION_ID',
    'ORGX_MCP_ACCESS_TOKEN',
    'ORGX_WORKSPACE_ROOT',
    'ORGX_RUNNER_INSTANCE_ID',
    'ORGX_ACTIVATION_ATTEMPT_ID',
    'ORGX_RUNNER_ROLE',
    'rejectManagedRunnerOptions',
    'HOST_ACCESS_ACK_ENV',
  ],
  'cli.mjs'
);

const readme = await read('README.md');
includesAll(
  readme,
  [
    '@deepseek-ai/dsh@0.1.0-rc.6',
    'npx @useorgx/wizard@latest setup',
    'dsh plugin --profile headless add @useorgx/deepseek-harness-plugin@0.1.0',
    'npm pack --ignore-scripts',
    '`file:` URL',
    'developer preview',
    'tools only',
    'MCP Resources and Prompts',
    'ORGX_INSTALLATION_ID',
    'unmanaged gateway protocol v1',
    'ORGX_ACTIVATION_ATTEMPT_ID',
    'https://api.deepseek.com/user/balance',
    'initialize plus `tools/list`',
    'workspace-write',
    'ORGX_DEEPSEEK_HOST_ACCESS_ACK=1',
    'same-user file reads',
    'process visibility',
    'network access',
    'ORGX_RECEIPT_OUTBOX_PATH',
    'mode-0700',
    'mode-0600',
    'every 15-second heartbeat tick',
    '15 seconds',
    'both mean unknown',
    'conservative\ndispatch estimate',
    'metering quality',
    'budget caps',
    'outcome_kind: awaiting_review',
    'outcome_kind: blocked',
    'test/*.node-test.mjs',
  ],
  'README.md'
);

const license = await read('LICENSE');
includesAll(
  license,
  ['MIT License', 'Copyright (c) 2026 OrgX', 'THE SOFTWARE IS PROVIDED "AS IS"'],
  'LICENSE'
);

console.log(`deepseek-harness-plugin validation passed (${checks} checks)`);
