import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../lib/peer/PeerCli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(HERE, '..', 'lib', 'peer', 'cli.mjs');

const validEnv = {
  ORGX_API_KEY: 'oxk_test',
  ORGX_MCP_ACCESS_TOKEN: 'oauth_mcp_test',
  DEEPSEEK_API_KEY: 'deepseek_test',
  ORGX_WORKSPACE_ID: 'workspace-1',
  ORGX_INSTALLATION_ID: 'install.deepseek-1',
  ORGX_WORKSPACE_ROOT: '/workspace',
  ORGX_DEEPSEEK_HOST_ACCESS_ACK: '1',
};

describe('peer CLI', () => {
  it('passes the stable installation and credential-probe environment to startPeer', async () => {
    let options;
    const peer = { stop: async () => {} };
    const result = await main(validEnv, {
      startPeer: async (value) => {
        options = value;
        return peer;
      },
      registerSignals: false,
      logger: { log() {} },
    });

    assert.equal(result, peer);
    assert.equal(options.installationId, 'install.deepseek-1');
    assert.equal(options.workspaceId, 'workspace-1');
    assert.equal(options.workspaceRoot, '/workspace');
    assert.equal(options.env, validEnv);
    assert.equal('runnerInstanceId' in options, false);
    assert.equal('activationAttemptId' in options, false);
    assert.equal('runnerRole' in options, false);
  });

  it('requires every unmanaged peer credential and identity input', async () => {
    for (const name of [
      'ORGX_API_KEY',
      'ORGX_MCP_ACCESS_TOKEN',
      'DEEPSEEK_API_KEY',
      'ORGX_WORKSPACE_ID',
      'ORGX_INSTALLATION_ID',
      'ORGX_WORKSPACE_ROOT',
    ]) {
      const env = { ...validEnv };
      delete env[name];
      await assert.rejects(
        main(env, { startPeer: async () => ({ stop() {} }) }),
        /are required/
      );
    }
  });

  it('requires informed acknowledgement of host read, process, and network access', async () => {
    const env = { ...validEnv };
    delete env.ORGX_DEEPSEEK_HOST_ACCESS_ACK;
    await assert.rejects(
      main(env, { startPeer: async () => ({ stop() {} }) }),
      /workspace-write limits mutations but does not isolate same-user file reads, process visibility, or network access/
    );
  });

  it('rejects managed-runner activation environment in this v1 preview', async () => {
    for (const [name, value] of [
      ['ORGX_RUNNER_INSTANCE_ID', 'candidate.act.12345678'],
      ['ORGX_ACTIVATION_ATTEMPT_ID', 'act.12345678'],
      ['ORGX_RUNNER_ROLE', 'candidate'],
    ]) {
      await assert.rejects(
        main(
          { ...validEnv, [name]: value },
          { startPeer: async () => ({ stop() {} }), registerSignals: false }
        ),
        /supports only unmanaged gateway protocol v1/
      );
    }
  });

  it('executes through a symlinked package bin instead of skipping main', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orgx-dsh-bin-'));
    const link = join(root, 'orgx-deepseek-harness-peer');
    try {
      await symlink(BIN_PATH, link);
      const result = await runNode(link, {});
      assert.equal(result.code, 1);
      assert.match(result.stderr, /\[orgx-deepseek-harness\] startup failed:/);
      assert.match(result.stderr, /ORGX_API_KEY/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runNode(entry, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entry], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}
