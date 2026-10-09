import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cacheCredentialReadinessProbe,
  probeCredentialReadiness,
} from '../lib/peer/CredentialReadinessProbe.mjs';

describe('credential readiness', () => {
  it('refuses readiness without informed host-access acknowledgement', async () => {
    await assert.rejects(
      probeCredentialReadiness({
        env: {
          DEEPSEEK_API_KEY: 'present',
          ORGX_MCP_ACCESS_TOKEN: 'present',
        },
      }),
      /ORGX_DEEPSEEK_HOST_ACCESS_ACK=1 is required/
    );
  });

  it('requires successful non-spending DeepSeek and MCP exchanges', async () => {
    const observed = {
      provider: null,
      transport: null,
      listTools: 0,
      closed: 0,
    };
    const readiness = await probeCredentialReadiness({
      env: {
        ORGX_DEEPSEEK_HOST_ACCESS_ACK: '1',
        DEEPSEEK_API_KEY: 'deepseek-test-key',
        ORGX_MCP_ACCESS_TOKEN: 'mcp-oauth-token',
        DEEPSEEK_BASE_URL: 'https://spoofed.example.test',
      },
      fetch: async (url, init) => {
        observed.provider = { url: String(url), init };
        return {
          ok: true,
          status: 200,
          json: async () => ({ is_available: true, balance_infos: [] }),
        };
      },
      sdkLoader: async () => fakeSdk(observed, [{ name: 'orgx_list' }]),
    });

    assert.deepEqual(readiness, {
      authenticated: true,
      provider_authenticated: true,
      mcp_authenticated: true,
      auth_status: 'authenticated',
    });
    assert.equal(
      observed.provider.url,
      'https://api.deepseek.com/user/balance'
    );
    assert.equal(
      observed.provider.init.headers.Authorization,
      'Bearer deepseek-test-key'
    );
    assert.equal(
      observed.transport.options.requestInit.headers.Authorization,
      'Bearer mcp-oauth-token'
    );
    assert.equal(observed.listTools, 1);
    assert.equal(observed.transport.url, 'https://mcp.useorgx.com/mcp?profile=v2');
    assert.equal(observed.closed, 1);
  });

  it('does not treat rejected or merely present secrets as authentication', async () => {
    const observed = { transport: null, listTools: 0, closed: 0 };
    const readiness = await probeCredentialReadiness({
      env: {
        ORGX_DEEPSEEK_HOST_ACCESS_ACK: '1',
        DEEPSEEK_API_KEY: 'garbage-provider-key',
        ORGX_MCP_ACCESS_TOKEN: 'garbage-mcp-token',
      },
      fetch: async () => ({ ok: false, status: 401 }),
      sdkLoader: async () => fakeSdk(observed, []),
    });

    assert.equal(readiness.authenticated, false);
    assert.equal(readiness.provider_authenticated, false);
    assert.equal(readiness.mcp_authenticated, true);
    assert.equal(readiness.auth_status, 'provider_auth_rejected');
  });

  it('fails closed when MCP initialization or tool listing cannot be proved', async () => {
    const observed = { transport: null, listTools: 0, closed: 0 };
    const readiness = await probeCredentialReadiness({
      env: {
        ORGX_DEEPSEEK_HOST_ACCESS_ACK: '1',
        DEEPSEEK_API_KEY: 'valid-provider-key',
        ORGX_MCP_ACCESS_TOKEN: 'expired-mcp-token',
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ is_available: true }),
      }),
      sdkLoader: async () => fakeSdk(observed, null),
    });

    assert.equal(readiness.authenticated, false);
    assert.equal(readiness.provider_authenticated, true);
    assert.equal(readiness.mcp_authenticated, false);
    assert.equal(readiness.auth_status, 'mcp_probe_failed');
    assert.equal(observed.closed, 1);
  });

  it('coalesces concurrent probes and reuses bounded-TTL evidence', async () => {
    let now = 1_000;
    let calls = 0;
    const cached = cacheCredentialReadinessProbe(
      async () => {
        calls += 1;
        return {
          authenticated: true,
          provider_authenticated: true,
          mcp_authenticated: true,
          auth_status: 'authenticated',
        };
      },
      { ttlMs: 100, now: () => now }
    );

    const [first, second] = await Promise.all([cached(), cached()]);
    assert.equal(calls, 1);
    assert.equal(first, second);
    await cached();
    assert.equal(calls, 1);
    now = 1_101;
    await cached();
    assert.equal(calls, 2);
  });
});

function fakeSdk(observed, tools) {
  class StreamableHTTPClientTransport {
    constructor(url, options) {
      observed.transport = { url: String(url), options };
    }
  }
  class Client {
    async connect() {}

    async listTools() {
      observed.listTools += 1;
      if (tools === null) throw new Error('MCP authentication rejected');
      return { tools };
    }

    async close() {
      observed.closed += 1;
    }
  }
  return { Client, StreamableHTTPClientTransport };
}
