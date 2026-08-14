# OrgX for DeepSeek Harness

`@useorgx/deepseek-harness-plugin` adds OrgX MCP tools to a DeepSeek Harness
profile and can run a workspace-bound OrgX gateway peer through Harness
headless mode.

This package is a developer preview. It is private, unsigned, and not
published. A local install proves only that the package is present; it does not
prove gateway admission, a successful dispatch, deployment, or production use.

## Install the local bundle

DeepSeek Harness is pinned to `0.1.0-rc.6`. From this package directory, use
Node `^22.19.0` or `>=24.0.0` and run exactly:

```sh
npm install --global @deepseek-ai/dsh@0.1.0-rc.6
export ORGX_MCP_ACCESS_TOKEN='your_orgx_oauth_access_token'
export DEEPSEEK_API_KEY='your_deepseek_key'
PACKAGE_TARBALL="$(npm pack --ignore-scripts)"
dsh plugin --profile headless add "file:$PWD/$PACKAGE_TARBALL"
dsh --profile headless --dump-config
dsh --profile headless "List the OrgX tools available in this workspace."
```

Packing first is intentional. Harness installs the tarball and its pinned
runtime dependencies into the profile; a bare local link does not provide that
clean-install guarantee.

The bundle mounts one `@deepseek-ai/dsh-mcp-client` instance named `orgx`. It
connects to `https://mcp.useorgx.com/mcp` over Streamable HTTP and sends
`Authorization: Bearer $ORGX_MCP_ACCESS_TOKEN`. That value must be a
client-managed OrgX OAuth 2.1 access token; the `oxk_` gateway key is not valid
for hosted MCP. Set `ORGX_MCP_URL` to use another OrgX MCP endpoint. Startup
fails when the OAuth token is missing or the initial MCP connection and tool
sync fail. This preview does not run the browser PKCE flow or refresh tokens;
replace the client-managed access token when it expires.

DeepSeek Harness `0.1.0-rc.6` bridges MCP tools only. MCP Resources and Prompts
are not available through this client. Non-text MCP blocks also have a lossy
model-facing projection even when the execution-local result retains their
JSON blocks.

## Run the OrgX peer

The peer sets the execution cwd inside `ORGX_WORKSPACE_ROOT`; a requested
repository that resolves outside that directory fails before Harness starts.
This is a path and mutation boundary, not host isolation. Harness
`workspace-write` does not confine same-user file reads, process visibility, or
network access, so a model or tool can observe other host data or send data over
the network. Set `ORGX_DEEPSEEK_HOST_ACCESS_ACK=1` only after accepting that
risk; startup and credential readiness fail without the acknowledgement.

Use an API key scoped for `gateway:drive` and `plugin:heartbeat`. The OrgX
gateway-key response returns an `installation_id`; keep that stable value with
the key and pass both unchanged on every start.

```sh
export ORGX_API_KEY='oxk_your_workspace_key'
export ORGX_MCP_ACCESS_TOKEN='your_orgx_oauth_access_token'
export DEEPSEEK_API_KEY='your_deepseek_key'
export ORGX_WORKSPACE_ID='your-workspace-uuid'
export ORGX_INSTALLATION_ID='install.your-stable-installation-id'
export ORGX_WORKSPACE_ROOT='/absolute/path/to/the/workspace'
export ORGX_DEEPSEEK_HOST_ACCESS_ACK='1'
dsh plugin --profile headless exec orgx-deepseek-harness-peer
```

This preview is an unmanaged gateway protocol v1 peer. It does not implement
the candidate/canonical activation and promotion lifecycle. Supplying
`ORGX_RUNNER_INSTANCE_ID`, `ORGX_ACTIVATION_ATTEMPT_ID`, or `ORGX_RUNNER_ROLE`
fails startup clearly; those fields are never sent in its heartbeat or socket
URL.

Before opening its WebSocket, the peer writes a gateway heartbeat with
transport and dispatch readiness false. It advertises dispatch readiness only
after all of these checks succeed:

- `dsh --version` proves the pinned runtime process is alive;
- the pinned official `https://api.deepseek.com/user/balance` endpoint accepts
  `DEEPSEEK_API_KEY` and reports `is_available: true` without making an
  inference request; and
- an MCP Streamable HTTP initialize plus `tools/list` exchange accepts
  `ORGX_MCP_ACCESS_TOKEN`.

Secret presence and a credential-free version command are never treated as
authentication. Probe failures, rejected or expired credentials, and missing
evidence remain fail-closed. Successful evidence is cached for 45 seconds; the
peer refreshes gateway presence every 15 seconds and writes a best-effort
offline heartbeat when the socket closes.

The DSH child receives the provider key and separately scoped MCP access token,
but not the gateway key. Ambient `DSH_*` controls are not forwarded except
`DSH_HOME`; the child is forced to `workspace-write` permission and telemetry
is disabled so ambient full-access or OTLP-export settings cannot override
those two policies. These settings still do not isolate host reads, processes,
or network access.

Optional runtime settings:

- `ORGX_BASE_URL` changes the OrgX gateway base URL.
- `ORGX_RECEIPT_OUTBOX_PATH` sets an absolute durable-receipt directory. The
  default is under the current user's OrgX state directory.
- `ORGX_DEEPSEEK_HARNESS_BIN` changes the executable path from `dsh`.
- `ORGX_DEEPSEEK_HARNESS_PROFILE` changes the profile from `headless`.
- `ORGX_DEEPSEEK_HARNESS_MODEL` activates the packaged model patch for the
  `deepseek-official` provider. It changes the composition default; a model
  already saved in DSH settings can still take precedence.

Harness headless stdout contains final assistant text and an exit code, but no
token or cost accounting. The driver wire message must therefore carry numeric
`tokens_used: 0` and `cost_estimate_cents: 0`; both mean unknown at this source,
not free. OrgX canonicalizes the persisted DeepSeek cost to its conservative
dispatch estimate, records metering quality, and accumulates that estimate in
budget caps. A zero process exit reports `outcome_kind: awaiting_review`: the
process finished, but the work is not yet accepted, merged, deployed, or
production-proven.

The SDK's WebSocket send has no server acknowledgement, so the application owns
durability. Before yielding `task.started`, the peer atomically writes a
pre-start reservation marker. If that write fails, it closes the inner iterator
before Harness can spawn and best-effort POSTs a blocked receipt. Before yielding
every post-start `task.completed` frame, it atomically writes the exact v1 HTTP
receipt to the mode-0700 outbox using a mode-0600 file, then POSTs it to the
idempotent run-receipt endpoint. No key or token is written to either file.

Only a 2xx response removes a terminal receipt. If final persistence fails
after Harness has completed, the peer immediately attempts the bound HTTP
receipt directly and still yields the original completion. A 2xx clears the
reservation; if HTTP also fails, the completion stays in an in-memory retry
queue and its reservation marker remains. Pending receipts retry on startup,
reconnect, and every 15-second heartbeat tick. A restart with an unresolved
reservation fails closed with a repair message instead of risking re-execution.

The pinned SDK cannot durably recover socket-only `task.failed`. After a run
has started, this peer therefore records the failure reason as a step and emits
`outcome_kind: blocked`; cancellation emits `outcome_kind: abandoned`. Both use
the application outbox. A duplicate rejected before `task.started` remains
`task.failed` and cannot terminalize the dispatch that already owns that run id.

## Validate

For package development, install the pinned dependencies without lifecycle
scripts, then run the deterministic checks:

```sh
npm install --ignore-scripts --no-package-lock
npm run validate
```

The package test script runs `node:test` explicitly over
`test/*.node-test.mjs`. The Node-only suffix keeps these suites out of the
repository's root Vitest discovery while preserving them in `npm run validate`.

Validation checks the bundle and manifest, evidence-backed readiness,
workspace and child-environment boundaries, cancellation and duplicate races,
unmanaged protocol-v1 heartbeats, and the pinned SDK's disconnect-time HTTP
failure recovery. It does not contact OrgX or DeepSeek.
