/**
 * Non-spending credential readiness for the DeepSeek Harness peer.
 *
 * Executable discovery and secret presence are not authentication evidence.
 * Readiness requires both a bounded DeepSeek balance lookup and a complete MCP
 * initialize/tools-list exchange. Failures collapse to stable reason codes;
 * provider or server response bodies are never logged or returned.
 */

import {
  HOST_ACCESS_ACK_ENV,
  requireHostAccessAcknowledgment,
} from './HostAccessAcknowledgment.mjs';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MCP_URL = 'https://mcp.useorgx.com/mcp';
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_TTL_MS = 45_000;

export function createCredentialReadinessProbe(opts = {}) {
  const env = opts.env ?? process.env;
  requireHostAccessAcknowledgment(env[HOST_ACCESS_ACK_ENV]);
  const probe = () =>
    probeCredentialReadiness({
      env,
      fetch: opts.fetch,
      sdkLoader: opts.sdkLoader,
      timeoutMs: opts.timeoutMs,
    });
  return cacheCredentialReadinessProbe(probe, {
    ttlMs: opts.ttlMs,
    now: opts.now,
  });
}

export async function probeCredentialReadiness(opts = {}) {
  const env = opts.env ?? process.env;
  requireHostAccessAcknowledgment(env[HOST_ACCESS_ACK_ENV]);
  const timeoutMs = positiveInteger(
    opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    'Credential probe timeout'
  );
  const [provider, mcp] = await Promise.all([
    probeDeepSeekCredential({
      apiKey: env.DEEPSEEK_API_KEY,
      // The execution child uses DSH's official DeepSeek adapter. Ambient
      // endpoint overrides are intentionally ignored so readiness cannot prove
      // credentials against a different or attacker-controlled service.
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      fetch: opts.fetch,
      timeoutMs,
    }),
    probeOrgXMcpCredential({
      accessToken: env.ORGX_MCP_ACCESS_TOKEN,
      url: env.ORGX_MCP_URL ?? DEFAULT_MCP_URL,
      fetch: opts.fetch,
      sdkLoader: opts.sdkLoader,
      timeoutMs,
    }),
  ]);
  const authenticated = provider.ok && mcp.ok;
  return {
    authenticated,
    provider_authenticated: provider.ok,
    mcp_authenticated: mcp.ok,
    auth_status: authenticated
      ? 'authenticated'
      : !provider.ok
      ? provider.reason
      : mcp.reason,
  };
}

export async function probeDeepSeekCredential(opts) {
  const apiKey = optionalSecret(opts.apiKey);
  if (!apiKey) return failed('provider_credential_missing');
  const request = opts.fetch ?? globalThis.fetch;
  if (typeof request !== 'function')
    return failed('provider_probe_unavailable');

  let url;
  try {
    url = endpoint(opts.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL, 'user/balance');
  } catch {
    return failed('provider_endpoint_invalid');
  }
  const signal = AbortSignal.timeout(
    positiveInteger(
      opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      'Provider probe timeout'
    )
  );
  try {
    const response = await request(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal,
    });
    if (!response.ok) {
      return failed(
        response.status === 401 || response.status === 403
          ? 'provider_auth_rejected'
          : response.status === 402
          ? 'provider_balance_unavailable'
          : 'provider_probe_failed'
      );
    }
    const body = await response.json();
    return body?.is_available === true
      ? { ok: true, reason: null }
      : failed('provider_balance_unavailable');
  } catch {
    return failed('provider_probe_failed');
  }
}

export async function probeOrgXMcpCredential(opts) {
  const accessToken = optionalSecret(opts.accessToken);
  if (!accessToken) return failed('mcp_credential_missing');
  let url;
  try {
    url = new URL(opts.url ?? DEFAULT_MCP_URL);
  } catch {
    return failed('mcp_endpoint_invalid');
  }

  let client;
  try {
    const { Client, StreamableHTTPClientTransport } = await (
      opts.sdkLoader ?? loadMcpSdk
    )();
    const timeoutMs = positiveInteger(
      opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      'MCP probe timeout'
    );
    const signal = AbortSignal.timeout(timeoutMs);
    client = new Client({
      name: 'orgx-deepseek-harness-readiness',
      version: '0.1.0',
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      },
      ...(typeof opts.fetch === 'function' ? { fetch: opts.fetch } : {}),
      reconnectionOptions: {
        maxReconnectionDelay: 1,
        initialReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
    await client.connect(transport);
    const result = await client.listTools(undefined, {
      signal,
      timeout: timeoutMs,
    });
    return Array.isArray(result?.tools)
      ? { ok: true, reason: null }
      : failed('mcp_tools_invalid');
  } catch {
    return failed('mcp_probe_failed');
  } finally {
    await Promise.resolve(client?.close?.()).catch(() => undefined);
  }
}

export function cacheCredentialReadinessProbe(probe, opts = {}) {
  if (typeof probe !== 'function') {
    throw new TypeError('Credential readiness probe must be a function');
  }
  const ttlMs = positiveInteger(
    opts.ttlMs ?? DEFAULT_PROBE_TTL_MS,
    'Credential probe TTL'
  );
  const now = opts.now ?? Date.now;
  let cached;
  let validUntil = 0;
  let pending;

  return async () => {
    const observedAt = now();
    if (cached && observedAt < validUntil) return cached;
    if (pending) return pending;
    pending = Promise.resolve()
      .then(probe)
      .then((result) => normalizeReadiness(result))
      .catch(() => normalizeReadiness())
      .then((result) => {
        cached = result;
        validUntil = now() + ttlMs;
        return result;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

function normalizeReadiness(value = {}) {
  const providerAuthenticated = value.provider_authenticated === true;
  const mcpAuthenticated = value.mcp_authenticated === true;
  const authenticated =
    value.authenticated === true && providerAuthenticated && mcpAuthenticated;
  return Object.freeze({
    authenticated,
    provider_authenticated: providerAuthenticated,
    mcp_authenticated: mcpAuthenticated,
    auth_status: authenticated
      ? 'authenticated'
      : typeof value.auth_status === 'string' && value.auth_status.trim()
      ? value.auth_status.trim()
      : 'credentials_unverified',
  });
}

async function loadMcpSdk() {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  return { Client, StreamableHTTPClientTransport };
}

function endpoint(baseUrl, suffix) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${suffix}`;
  url.search = '';
  url.hash = '';
  return url;
}

function failed(reason) {
  return { ok: false, reason };
}

function optionalSecret(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

export {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_MCP_URL,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_TTL_MS,
};
