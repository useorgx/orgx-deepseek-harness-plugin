/**
 * Drive DeepSeek Harness headless mode for one OrgX gateway dispatch.
 *
 * Harness 0.1.0-rc.6 prints only the final assistant text and an exit code.
 * This driver therefore reports process-level progress and deliberately marks
 * usage/cost as zero-valued unknowns in the protocol's required number fields.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOST_ACCESS_ACK_ENV,
  requireHostAccessAcknowledgment,
} from './HostAccessAcknowledgment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const MODEL_PATCH_PATH = resolve(PLUGIN_ROOT, 'model.patch.yml');
const AUDITED_DSH_VERSION = '0.1.0-rc.6';
const CANCEL_GRACE_MS = 3_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_STEP_CHARS = 2_000;

export class DeepSeekHarnessDriver {
  id = 'deepseek_harness';

  constructor(opts = {}) {
    // Preserve PATH and other ordinary process facts while allowing tests and
    // callers to override explicit values. Credentials are never logged.
    this.env = { ...process.env, ...(opts.env ?? {}) };
    requireHostAccessAcknowledgment(this.env[HOST_ACCESS_ACK_ENV]);
    this.bin = requiredString(
      opts.bin ?? this.env.ORGX_DEEPSEEK_HARNESS_BIN ?? 'dsh',
      'DeepSeek Harness executable'
    );
    this.profile = requiredString(
      opts.profile ?? this.env.ORGX_DEEPSEEK_HARNESS_PROFILE ?? 'headless',
      'DeepSeek Harness profile'
    );
    this.model = optionalString(
      opts.model ?? this.env.ORGX_DEEPSEEK_HARNESS_MODEL
    );
    this.workspaceRoot = resolve(
      requiredString(
        opts.workspaceRoot ?? this.env.ORGX_WORKSPACE_ROOT ?? process.cwd(),
        'OrgX workspace root'
      )
    );
    this.spawn = opts.spawn ?? nodeSpawn;
    this.credentialProbe =
      typeof opts.credentialProbe === 'function'
        ? opts.credentialProbe
        : async () => ({
            authenticated: false,
            provider_authenticated: false,
            mcp_authenticated: false,
            auth_status: 'credentials_unverified',
          });
    this.running = new Map();
  }

  async detect() {
    try {
      const out = await runOnce(this.spawn, this.bin, ['--version'], {
        env: buildHarnessProbeEnv(this.env),
        timeoutMs: 5_000,
      });
      const version = normalizeDshVersion(out.stdout);
      if (version !== AUDITED_DSH_VERSION) {
        return unsupportedVersionStatus(out.stdout, version);
      }
      return {
        installed: true,
        // Executable discovery is not credential evidence. Authentication is
        // established only by probe() after bounded provider and MCP calls.
        authenticated: false,
        version,
        subscription_active: false,
        auth_status: 'credentials_unverified',
      };
    } catch (error) {
      const message = errorMessage(error);
      if (isMissingExecutable(error, message)) {
        return {
          installed: false,
          authenticated: false,
          subscription_active: false,
          error: message,
        };
      }
      return {
        installed: true,
        authenticated: false,
        subscription_active: false,
        error: message,
      };
    }
  }

  async probe() {
    try {
      const out = await runOnce(this.spawn, this.bin, ['--version'], {
        env: buildHarnessProbeEnv(this.env),
        timeoutMs: 2_500,
      });
      const version = normalizeDshVersion(out.stdout);
      if (version !== AUDITED_DSH_VERSION) {
        return {
          authenticated: false,
          provider_authenticated: false,
          mcp_authenticated: false,
          subscription_active: false,
          auth_status: 'unsupported_version',
          session_alive: false,
          queue_depth: this.running.size,
          ...(version ? { version } : {}),
          error: unsupportedVersionError(out.stdout),
        };
      }
      const readiness = await this.credentialProbe();
      const providerAuthenticated = readiness?.provider_authenticated === true;
      const mcpAuthenticated = readiness?.mcp_authenticated === true;
      const authenticated =
        readiness?.authenticated === true &&
        providerAuthenticated &&
        mcpAuthenticated;
      return {
        authenticated,
        provider_authenticated: providerAuthenticated,
        mcp_authenticated: mcpAuthenticated,
        subscription_active: authenticated,
        auth_status: authenticated
          ? 'authenticated'
          : optionalString(readiness?.auth_status) ?? 'credentials_unverified',
        session_alive: true,
        queue_depth: this.running.size,
      };
    } catch {
      return {
        authenticated: false,
        provider_authenticated: false,
        mcp_authenticated: false,
        subscription_active: false,
        auth_status: 'probe_failed',
        session_alive: false,
        queue_depth: this.running.size,
      };
    }
  }

  async *dispatch(task, context) {
    const runId = requiredString(context?.run_id, 'OrgX run id');
    if (this.running.has(runId)) {
      yield failure(
        runId,
        `DeepSeek Harness run ${runId} is already active`,
        false
      );
      return;
    }

    // Reserve synchronously before the first yield or await. This closes both
    // the generator-step cancellation gap and concurrent duplicate dispatch.
    const active = {
      child: null,
      cancelled: false,
      terminationRequested: false,
    };
    this.running.set(runId, active);
    const startedAt = new Date().toISOString();

    try {
      yield { kind: 'task.started', run_id: runId, started_at: startedAt };
      if (active.cancelled) {
        yield failure(runId, 'DeepSeek Harness run cancelled', false);
        return;
      }

      let cwd;
      let prompt;
      try {
        cwd = await resolveWorkspace(this.workspaceRoot, task?.repo_path);
        if (active.cancelled) {
          yield failure(runId, 'DeepSeek Harness run cancelled', false);
          return;
        }
        prompt = renderPrompt(task);
      } catch (error) {
        yield failure(runId, errorMessage(error), false);
        return;
      }

      const args = ['--profile', this.profile];
      // The runner key can drive the Gateway and heartbeat APIs. It is not an
      // execution credential and must never enter the model/tool process. DSH
      // receives only its provider key plus a separately scoped MCP OAuth token.
      const childEnv = buildHarnessChildEnv(this.env, runId);
      if (this.model) {
        args.push('--patch', MODEL_PATCH_PATH);
        childEnv.ORGX_DEEPSEEK_HARNESS_MODEL = this.model;
      }
      args.push(prompt);

      let child;
      try {
        child = this.spawn(this.bin, args, {
          cwd,
          env: childEnv,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        active.child = child;
      } catch (error) {
        yield failure(
          runId,
          `DeepSeek Harness could not start: ${errorMessage(error)}`,
          false
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let firstResponseAt;
      child.stdout?.on('data', (chunk) => {
        if (!firstResponseAt) firstResponseAt = new Date().toISOString();
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = appendBounded(stderr, chunk);
      });

      try {
        const result = await waitForChild(child);
        if (active.cancelled) {
          yield failure(runId, 'DeepSeek Harness run cancelled', false);
          return;
        }

        if (result.code !== 0) {
          const detail = redactKnownSecrets(stderr.trim(), childEnv);
          const suffix = detail ? `: ${clip(detail, 500)}` : '';
          const exit = result.signal
            ? `terminated by ${result.signal}`
            : `exited ${String(result.code)}`;
          yield failure(
            runId,
            `DeepSeek Harness ${exit}${suffix}`,
            isProbablyRecoverable(detail)
          );
          return;
        }

        const finalText = stdout.trim();
        if (finalText) {
          yield {
            kind: 'task.step',
            run_id: runId,
            step: {
              kind: 'chat',
              summary: clip(finalText, MAX_STEP_CHARS),
            },
          };
        }

        yield completion(runId, startedAt, firstResponseAt);
      } catch (error) {
        if (active.cancelled) {
          yield failure(runId, 'DeepSeek Harness run cancelled', false);
        } else {
          yield failure(
            runId,
            `DeepSeek Harness process failed: ${errorMessage(error)}`,
            isMissingExecutable(error, errorMessage(error))
          );
        }
      }
    } finally {
      if (this.running.get(runId) === active) this.running.delete(runId);
    }
  }

  async cancel(runId) {
    const active = this.running.get(runId);
    if (!active || active.cancelled) return;
    active.cancelled = true;
    terminateActiveChild(active);
  }
}

function completion(runId, startedAt, firstResponseAt) {
  return {
    kind: 'task.completed',
    run_id: runId,
    // Process completion is not acceptance. OrgX review/policy owns any later
    // transition to accepted, shipped, merged, deployed, or production-proven.
    outcome_kind: 'awaiting_review',
    started_at: startedAt,
    ...(firstResponseAt ? { first_response_at: firstResponseAt } : {}),
    completed_at: new Date().toISOString(),
    // Required v1 numeric fields. DSH headless exposes no accounting.
    tokens_used: 0,
    provider: 'other',
    source_sub_type: 'api_key',
    source_driver: 'deepseek_harness',
    cost_estimate_cents: 0,
  };
}

function terminateActiveChild(active) {
  const child = active.child;
  if (!child || active.terminationRequested) return;
  active.terminationRequested = true;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, CANCEL_GRACE_MS);
  timer.unref?.();
}

function failure(runId, reason, recoverable) {
  return {
    kind: 'task.failed',
    run_id: runId,
    reason,
    recoverable,
  };
}

function normalizeDshVersion(stdout) {
  const raw = optionalString(stdout);
  if (!raw) return undefined;
  const match = /^(?:dsh\s+)?v?([^\s]+)$/.exec(raw);
  return match?.[1];
}

function unsupportedVersionError(stdout) {
  const received = optionalString(stdout) ?? '(empty output)';
  return `DeepSeek Harness ${AUDITED_DSH_VERSION} is required; received ${clip(
    JSON.stringify(received),
    200
  )}`;
}

function unsupportedVersionStatus(stdout, version) {
  return {
    installed: false,
    authenticated: false,
    subscription_active: false,
    auth_status: 'unsupported_version',
    ...(version ? { version } : {}),
    error: unsupportedVersionError(stdout),
  };
}

async function resolveWorkspace(root, requestedPath) {
  const rootPath = await realDirectory(root, 'OrgX workspace root');
  const candidate = requestedPath
    ? resolve(rootPath, requiredString(requestedPath, 'Task repository path'))
    : rootPath;
  const targetPath = await realDirectory(candidate, 'Task repository path');
  const pathFromRoot = relative(rootPath, targetPath);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(
      `Task repository resolves outside ORGX_WORKSPACE_ROOT (${rootPath})`
    );
  }
  return targetPath;
}

async function realDirectory(path, label) {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory())
    throw new Error(`${label} is not a directory: ${canonical}`);
  return canonical;
}

function renderPrompt(task) {
  if (!task || typeof task !== 'object')
    throw new Error('OrgX task is required');
  const title = requiredString(task.title, 'OrgX task title');
  const sections = [title];
  const description = optionalString(task.description);
  if (description) sections.push(description);
  if (Array.isArray(task.skill_ids) && task.skill_ids.length > 0) {
    const skills = task.skill_ids.map((value) =>
      requiredString(value, 'OrgX skill id')
    );
    sections.push(
      `Skills to honor:\n${skills.map((id) => `- ${id}`).join('\n')}`
    );
  }
  return sections.join('\n\n');
}

function runOnce(spawnFn, command, args, opts) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnFn(command, args, {
        env: opts.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        rejectPromise(
          new Error(`${command} timed out after ${opts.timeoutMs}ms`)
        )
      );
    }, opts.timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', (error) => finish(() => rejectPromise(error)));
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) resolvePromise({ stdout, stderr });
        else
          rejectPromise(
            new Error(
              `${command} exited ${String(code)}: ${clip(stderr.trim(), 300)}`
            )
          );
      });
    });
  });
}

function waitForChild(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.once('error', (error) => settle(() => rejectPromise(error)));
    child.once('close', (code, signal) => {
      settle(() => resolvePromise({ code, signal }));
    });
  });
}

function appendBounded(current, chunk) {
  const next = current + Buffer.from(chunk).toString('utf8');
  if (Buffer.byteLength(next, 'utf8') <= MAX_CAPTURE_BYTES) return next;
  return Buffer.from(next, 'utf8')
    .subarray(-MAX_CAPTURE_BYTES)
    .toString('utf8');
}

function redactKnownSecrets(value, env) {
  let redacted = value;
  for (const name of [
    'ORGX_API_KEY',
    'ORGX_MCP_ACCESS_TOKEN',
    'DEEPSEEK_API_KEY',
  ]) {
    const secret = env[name];
    if (hasValue(secret)) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function buildHarnessChildEnv(env, runId) {
  const allowedNames = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TERM',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'DEEPSEEK_API_KEY',
    'ORGX_MCP_ACCESS_TOKEN',
    'ORGX_MCP_URL',
    // DSH_HOME is required to resolve the selected profile. No other ambient
    // DSH_* control variable is inherited into a governed dispatch.
    'DSH_HOME',
  ]);
  const childEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && allowedNames.has(name)) {
      childEnv[name] = value;
    }
  }
  // Headless runs are always workspace-bounded and telemetry-off even when a
  // hostile parent process attempts broader DSH policy or OTLP export.
  childEnv.DSH_PERMISSION_MODE = 'workspace-write';
  childEnv.DSH_TELEMETRY_DISABLED = '1';
  childEnv.ORGX_RUN_ID = runId;
  return childEnv;
}

function buildHarnessProbeEnv(env) {
  const probeEnv = buildHarnessChildEnv(env, 'probe');
  delete probeEnv.ORGX_RUN_ID;
  delete probeEnv.DEEPSEEK_API_KEY;
  delete probeEnv.ORGX_MCP_ACCESS_TOKEN;
  return probeEnv;
}

function clip(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function isProbablyRecoverable(value) {
  return /(?:429|5\d\d|econn|network|rate.?limit|temporar|timed? ?out|timeout)/i.test(
    value
  );
}

function isMissingExecutable(error, message) {
  return error?.code === 'ENOENT' || /(?:ENOENT|not found)/i.test(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export {
  AUDITED_DSH_VERSION,
  MODEL_PATCH_PATH,
  PLUGIN_ROOT,
  buildHarnessChildEnv,
  buildHarnessProbeEnv,
  normalizeDshVersion,
  renderPrompt,
  resolveWorkspace,
};
