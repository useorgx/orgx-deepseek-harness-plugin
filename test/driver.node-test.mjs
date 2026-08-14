import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DeepSeekHarnessDriver,
  MODEL_PATCH_PATH,
} from '../lib/peer/DeepSeekHarnessDriver.mjs';

let fixtureRoot;
let workspace;
let repository;
let outside;
let executable;
let unsupportedExecutable;
let emptyVersionExecutable;
const HOST_ACK = { ORGX_DEEPSEEK_HOST_ACCESS_ACK: '1' };

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'orgx-dsh-peer-'));
  workspace = join(fixtureRoot, 'workspace');
  repository = join(workspace, 'repo');
  outside = join(fixtureRoot, 'outside');
  await mkdir(repository, { recursive: true });
  await mkdir(outside, { recursive: true });
  executable = join(fixtureRoot, 'dsh');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const fixtureRoot = ${JSON.stringify(fixtureRoot)};

if (process.argv.includes('--version')) {
  await writeFile(fixtureRoot + '/probe-env.json', JSON.stringify({
    gatewayKey: process.env.ORGX_API_KEY ?? null,
    mcpToken: process.env.ORGX_MCP_ACCESS_TOKEN ?? null,
    providerKey: process.env.DEEPSEEK_API_KEY ?? null,
  }));
  process.stdout.write('dsh 0.1.0-rc.6\\n');
  process.exit(0);
}
if (process.env.ORGX_RUN_ID) {
  await writeFile(fixtureRoot + '/' + process.env.ORGX_RUN_ID + '.json', JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    model: process.env.ORGX_DEEPSEEK_HARNESS_MODEL ?? null,
    runId: process.env.ORGX_RUN_ID ?? null,
    gatewayKey: process.env.ORGX_API_KEY ?? null,
    mcpToken: process.env.ORGX_MCP_ACCESS_TOKEN ?? null,
    permissionMode: process.env.DSH_PERMISSION_MODE ?? null,
    telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED ?? null,
    telemetryMode: process.env.DSH_TELEMETRY_MODE ?? null,
    telemetryOtlpUrl: process.env.DSH_TELEMETRY_OTLP_URL ?? null,
    cordisConfig: process.env.DSH_CORDIS_CONFIG ?? null,
    unknownDshControl: process.env.DSH_HOSTILE_CONTROL ?? null,
  }));
}
if (process.env.ORGX_RUN_ID === 'run-failure') {
  process.stderr.write('temporary timeout for ' + process.env.ORGX_MCP_ACCESS_TOKEN + '\\n');
  process.exit(1);
}
process.stdout.write('Harness completed the requested task.\\n');
`,
    { mode: 0o755 }
  );
  await chmod(executable, 0o755);
  unsupportedExecutable = join(fixtureRoot, 'unsupported-dsh');
  await writeFile(
    unsupportedExecutable,
    `#!/usr/bin/env node
process.stdout.write('dsh 9.9.9\\n');
`,
    { mode: 0o755 }
  );
  await chmod(unsupportedExecutable, 0o755);
  emptyVersionExecutable = join(fixtureRoot, 'empty-version-dsh');
  await writeFile(
    emptyVersionExecutable,
    `#!/usr/bin/env node
process.exit(0);
`,
    { mode: 0o755 }
  );
  await chmod(emptyVersionExecutable, 0o755);
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error('condition was not reached');
}

describe('DeepSeekHarnessDriver', () => {
  it('requires explicit acknowledgement of Harness host access', () => {
    assert.throws(
      () =>
        new DeepSeekHarnessDriver({
          bin: executable,
          workspaceRoot: workspace,
          env: { ORGX_DEEPSEEK_HOST_ACCESS_ACK: '0' },
        }),
      /does not isolate same-user file reads, process visibility, or network access/
    );
  });

  it('separates executable detection from verified provider and MCP readiness', async () => {
    const driver = new DeepSeekHarnessDriver({
      bin: executable,
      workspaceRoot: workspace,
      env: {
        ...HOST_ACK,
        DEEPSEEK_API_KEY: 'test-deepseek-key',
        ORGX_MCP_ACCESS_TOKEN: 'oauth_test_mcp',
      },
      credentialProbe: async () => ({
        authenticated: true,
        provider_authenticated: true,
        mcp_authenticated: true,
        auth_status: 'authenticated',
      }),
    });
    const status = await driver.detect();
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, false);
    assert.equal(status.subscription_active, false);
    assert.match(status.version, /0\.1\.0-rc\.6/);
    const probed = await driver.probe();
    assert.equal(probed.authenticated, true);
    assert.equal(probed.provider_authenticated, true);
    assert.equal(probed.mcp_authenticated, true);
    assert.equal(probed.subscription_active, true);
  });

  it('keeps readiness closed when secrets are merely present', async () => {
    const driver = new DeepSeekHarnessDriver({
      bin: executable,
      workspaceRoot: workspace,
      env: {
        ...HOST_ACK,
        DEEPSEEK_API_KEY: 'garbage-provider-key',
        ORGX_MCP_ACCESS_TOKEN: 'garbage-mcp-token',
      },
    });

    const status = await driver.detect();
    assert.equal(status.installed, true);
    assert.equal(status.subscription_active, false);
    assert.equal(status.authenticated, false);
    const probed = await driver.probe();
    assert.equal(probed.subscription_active, false);
    assert.equal(probed.authenticated, false);
    assert.equal(probed.auth_status, 'credentials_unverified');
  });

  it('rejects a successful but unaudited Harness version before credential readiness', async () => {
    let credentialProbeCalls = 0;
    const driver = new DeepSeekHarnessDriver({
      bin: unsupportedExecutable,
      workspaceRoot: workspace,
      env: HOST_ACK,
      credentialProbe: async () => {
        credentialProbeCalls += 1;
        return {
          authenticated: true,
          provider_authenticated: true,
          mcp_authenticated: true,
        };
      },
    });

    const detected = await driver.detect();
    assert.equal(detected.installed, false);
    assert.equal(detected.authenticated, false);
    assert.equal(detected.subscription_active, false);
    assert.equal(detected.auth_status, 'unsupported_version');
    assert.equal(detected.version, '9.9.9');
    assert.match(detected.error, /0\.1\.0-rc\.6 is required/);

    const probed = await driver.probe();
    assert.equal(probed.session_alive, false);
    assert.equal(probed.authenticated, false);
    assert.equal(probed.provider_authenticated, false);
    assert.equal(probed.mcp_authenticated, false);
    assert.equal(probed.subscription_active, false);
    assert.equal(probed.auth_status, 'unsupported_version');
    assert.equal(credentialProbeCalls, 0);
  });

  it('rejects a successful empty version response before credential readiness', async () => {
    let credentialProbeCalls = 0;
    const driver = new DeepSeekHarnessDriver({
      bin: emptyVersionExecutable,
      workspaceRoot: workspace,
      env: HOST_ACK,
      credentialProbe: async () => {
        credentialProbeCalls += 1;
        return {
          authenticated: true,
          provider_authenticated: true,
          mcp_authenticated: true,
        };
      },
    });

    const detected = await driver.detect();
    assert.equal(detected.installed, false);
    assert.equal(detected.authenticated, false);
    assert.equal(detected.subscription_active, false);
    assert.equal(detected.auth_status, 'unsupported_version');
    assert.equal(detected.version, undefined);
    assert.match(detected.error, /received "\(empty output\)"/);

    const probed = await driver.probe();
    assert.equal(probed.session_alive, false);
    assert.equal(probed.authenticated, false);
    assert.equal(probed.subscription_active, false);
    assert.equal(probed.auth_status, 'unsupported_version');
    assert.equal(credentialProbeCalls, 0);
  });

  it('runs version probes without gateway, MCP, or provider credentials', async () => {
    const probeLog = join(fixtureRoot, 'probe-env.json');
    const driver = new DeepSeekHarnessDriver({
      bin: executable,
      workspaceRoot: workspace,
      env: {
        ...HOST_ACK,
        ORGX_API_KEY: 'gateway-secret',
        ORGX_MCP_ACCESS_TOKEN: 'oauth-secret',
        DEEPSEEK_API_KEY: 'provider-secret',
      },
    });

    await driver.detect();
    assert.deepEqual(JSON.parse(await readFile(probeLog, 'utf8')), {
      gatewayKey: null,
      mcpToken: null,
      providerKey: null,
    });
  });

  it('runs headless inside the workspace and emits conservative completion attribution', async () => {
    const logPath = join(fixtureRoot, 'run-1.json');
    const driver = new DeepSeekHarnessDriver({
      bin: executable,
      profile: 'headless',
      model: 'deepseek-v4-pro',
      workspaceRoot: workspace,
      env: {
        ...HOST_ACK,
        DEEPSEEK_API_KEY: 'test-deepseek-key',
        ORGX_API_KEY: 'oxk_gateway_do_not_inherit',
        ORGX_MCP_ACCESS_TOKEN: 'oauth_mcp_child',
        DSH_HOME: join(fixtureRoot, 'dsh-home'),
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_MODE: 'FULL',
        DSH_TELEMETRY_OTLP_URL: 'https://exfil.example.test/otlp',
        DSH_CORDIS_CONFIG: '/tmp/hostile-cordis.yml',
        DSH_HOSTILE_CONTROL: 'crossed-boundary',
      },
    });
    const messages = await collect(
      driver.dispatch(
        {
          title: 'Inspect the repository',
          description: 'Return a bounded result.',
          repo_path: repository,
          skill_ids: ['orgx-runtime-reporting'],
          driver: 'deepseek_harness',
        },
        { run_id: 'run-1', idempotency_key: 'dispatch-1' }
      )
    );

    assert.deepEqual(
      messages.map((message) => message.kind),
      ['task.started', 'task.step', 'task.completed']
    );
    assert.equal(messages[1].step.kind, 'chat');
    assert.match(messages[1].step.summary, /Harness completed/);
    assert.deepEqual(
      {
        outcome_kind: messages[2].outcome_kind,
        tokens_used: messages[2].tokens_used,
        provider: messages[2].provider,
        source_sub_type: messages[2].source_sub_type,
        source_driver: messages[2].source_driver,
        cost_estimate_cents: messages[2].cost_estimate_cents,
      },
      {
        outcome_kind: 'awaiting_review',
        tokens_used: 0,
        provider: 'other',
        source_sub_type: 'api_key',
        source_driver: 'deepseek_harness',
        cost_estimate_cents: 0,
      }
    );
    assert.ok(messages[2].first_response_at);

    const invocation = JSON.parse(await readFile(logPath, 'utf8'));
    assert.equal(invocation.cwd, await realpath(repository));
    assert.equal(invocation.model, 'deepseek-v4-pro');
    assert.equal(invocation.runId, 'run-1');
    assert.equal(invocation.gatewayKey, null);
    assert.equal(invocation.mcpToken, 'oauth_mcp_child');
    assert.equal(invocation.permissionMode, 'workspace-write');
    assert.equal(invocation.telemetryDisabled, '1');
    assert.equal(invocation.telemetryMode, null);
    assert.equal(invocation.telemetryOtlpUrl, null);
    assert.equal(invocation.cordisConfig, null);
    assert.equal(invocation.unknownDshControl, null);
    assert.deepEqual(invocation.args.slice(0, 4), [
      '--profile',
      'headless',
      '--patch',
      MODEL_PATCH_PATH,
    ]);
    assert.match(invocation.args.at(-1), /Inspect the repository/);
    assert.match(invocation.args.at(-1), /orgx-runtime-reporting/);
  });

  it('fails before spawn when a task repository escapes the workspace', async () => {
    const logPath = join(fixtureRoot, 'run-outside.json');
    const driver = new DeepSeekHarnessDriver({
      bin: executable,
      workspaceRoot: workspace,
      env: HOST_ACK,
    });
    const messages = await collect(
      driver.dispatch(
        { title: 'Do not run', repo_path: outside, driver: 'deepseek_harness' },
        { run_id: 'run-outside', idempotency_key: 'dispatch-outside' }
      )
    );
    assert.deepEqual(
      messages.map((message) => message.kind),
      ['task.started', 'task.failed']
    );
    assert.match(messages[1].reason, /outside ORGX_WORKSPACE_ROOT/);
    await assert.rejects(readFile(logPath, 'utf8'), /ENOENT/);
  });

  it('redacts known keys from a recoverable Harness failure', async () => {
    const secret = 'oauth_mcp_do_not_echo';
    const driver = new DeepSeekHarnessDriver({
      bin: executable,
      workspaceRoot: workspace,
      env: { ...HOST_ACK, ORGX_MCP_ACCESS_TOKEN: secret },
    });
    const messages = await collect(
      driver.dispatch(
        {
          title: 'Fail safely',
          repo_path: repository,
          driver: 'deepseek_harness',
        },
        { run_id: 'run-failure', idempotency_key: 'dispatch-failure' }
      )
    );
    const failed = messages.at(-1);
    assert.equal(failed.kind, 'task.failed');
    assert.equal(failed.recoverable, true);
    assert.match(failed.reason, /\[REDACTED\]/);
    assert.doesNotMatch(failed.reason, new RegExp(secret));
  });

  it('latches cancellation at the exact first generator step before spawn', async () => {
    let spawnCalls = 0;
    const driver = new DeepSeekHarnessDriver({
      spawn: () => {
        spawnCalls += 1;
        throw new Error('cancelled dispatch must not spawn');
      },
      workspaceRoot: workspace,
      env: HOST_ACK,
    });
    const iterator = driver.dispatch(
      { title: 'Cancel before spawn', repo_path: repository },
      { run_id: 'run-pre-spawn-cancel', idempotency_key: 'dispatch-cancel' }
    );

    const first = await iterator.next();
    assert.equal(first.value.kind, 'task.started');
    assert.equal(driver.running.has('run-pre-spawn-cancel'), true);
    assert.equal(spawnCalls, 0);
    await driver.cancel('run-pre-spawn-cancel');
    const remaining = await collect(iterator);

    assert.equal(spawnCalls, 0);
    assert.deepEqual(remaining, [
      {
        kind: 'task.failed',
        run_id: 'run-pre-spawn-cancel',
        reason: 'DeepSeek Harness run cancelled',
        recoverable: false,
      },
    ]);
    assert.equal(driver.running.has('run-pre-spawn-cancel'), false);
  });

  it('rejects a concurrent iterator for the same run deterministically', async () => {
    let spawnCalls = 0;
    const child = successfulChild();
    const driver = new DeepSeekHarnessDriver({
      spawn: () => {
        spawnCalls += 1;
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
      workspaceRoot: workspace,
      env: HOST_ACK,
    });
    const context = {
      run_id: 'run-concurrent',
      idempotency_key: 'dispatch-concurrent',
    };
    const owner = driver.dispatch(
      { title: 'One owner', repo_path: repository },
      context
    );
    const duplicate = driver.dispatch(
      { title: 'Duplicate', repo_path: repository },
      context
    );
    const [ownerFirst, duplicateFirst] = await Promise.all([
      owner.next(),
      duplicate.next(),
    ]);

    assert.equal(ownerFirst.value.kind, 'task.started');
    assert.equal(duplicateFirst.value.kind, 'task.failed');
    assert.match(duplicateFirst.value.reason, /already active/);
    assert.equal(driver.running.has('run-concurrent'), true);
    assert.equal((await duplicate.next()).done, true);
    const ownerRemaining = await collect(owner);

    assert.equal(spawnCalls, 1);
    assert.equal(ownerRemaining.at(-1).kind, 'task.completed');
    assert.equal(driver.running.has('run-concurrent'), false);
  });

  it('terminates a spawned child with SIGTERM and removes the active run', async () => {
    const signals = [];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      signals.push(signal);
      child.signalCode = signal;
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    const driver = new DeepSeekHarnessDriver({
      spawn: () => child,
      workspaceRoot: workspace,
      env: HOST_ACK,
    });
    const result = collect(
      driver.dispatch(
        { title: 'Wait until cancelled', repo_path: repository },
        { run_id: 'run-cancel', idempotency_key: 'dispatch-cancel' }
      )
    );

    await waitFor(() => driver.running.get('run-cancel')?.child === child);
    await driver.cancel('run-cancel');
    const messages = await result;

    assert.deepEqual(signals, ['SIGTERM']);
    assert.deepEqual(
      messages.map((message) => message.kind),
      ['task.started', 'task.failed']
    );
    assert.equal(messages[1].reason, 'DeepSeek Harness run cancelled');
    assert.equal(messages[1].recoverable, false);
    assert.equal(driver.running.has('run-cancel'), false);
  });
});

function successfulChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}
