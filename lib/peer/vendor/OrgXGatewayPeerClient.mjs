/* Vendored from @useorgx/orgx-gateway-sdk 0.1.0-alpha.9 commit 49f3cad612954c448878dc62d0f9c6bc87fa0f79 (MIT). */

// node_modules/@useorgx/orgx-gateway-sdk/dist/execution.js
var DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
function validateExecutionEnvelope(envelope) {
  if (envelope.schemaVersion !== "1.0.0") {
    throw new Error("execution envelope schema version unsupported");
  }
  if (!envelope.workRef.workspaceId) {
    throw new Error("execution envelope requires a workspace reference");
  }
  if (!envelope.workRef.goalId && !envelope.workRef.objectiveId && !envelope.workRef.initiativeId) {
    throw new Error("execution envelope requires goal, objective, or initiative lineage");
  }
  if ((envelope.workRef.workstreamId || envelope.workRef.milestoneId || envelope.workRef.taskId) && !envelope.workRef.initiativeId) {
    throw new Error("nested work requires initiative lineage");
  }
  for (const digest of [
    envelope.digest,
    envelope.missionContractDigest,
    envelope.contextManifestDigest,
    envelope.capabilityLeaseDigest,
    envelope.runtimeProfileDigest,
    ...envelope.skillVersionDigests,
    ...envelope.toolManifestDigests
  ]) {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new Error("execution envelope contains an invalid digest");
    }
  }
  if (new Set(envelope.skillVersionDigests).size !== envelope.skillVersionDigests.length) {
    throw new Error("execution envelope skill digests must be unique");
  }
  if (new Set(envelope.toolManifestDigests).size !== envelope.toolManifestDigests.length) {
    throw new Error("execution envelope tool digests must be unique");
  }
}
function validateExecutionResult(result, envelope) {
  if (result.runId !== envelope.runId || result.attemptId !== envelope.attemptId || result.envelopeId !== envelope.id || result.envelopeDigest !== envelope.digest) {
    throw new Error("execution result does not match its envelope");
  }
  if (!sameWorkRef(result.workRef, envelope.workRef)) {
    throw new Error("execution result work lineage does not match its envelope");
  }
  if (result.receiptRefs.length === 0) {
    throw new Error("execution result requires at least one receipt");
  }
  if (["technically_complete", "outcome_pending", "accepted"].includes(result.disposition) && !result.proofPacketRef) {
    throw new Error(`${result.disposition} requires a proof packet`);
  }
  if (result.disposition === "accepted" && result.outcomeRefs.length === 0) {
    throw new Error("accepted execution requires an outcome");
  }
  if (!DIGEST_PATTERN.test(result.digest)) {
    throw new Error("execution result contains an invalid digest");
  }
}
async function validateExecutionFinalizationRequest(request, envelope) {
  if (request.schemaVersion !== "1.0.0") {
    throw new Error("execution finalization schema version unsupported");
  }
  if (request.runId !== envelope.runId || request.attemptId !== envelope.attemptId || request.envelopeId !== envelope.id || request.envelopeDigest !== envelope.digest) {
    throw new Error("execution finalization does not match its envelope");
  }
  if (request.verificationIds.length === 0) {
    throw new Error("execution finalization requires a verification source");
  }
  assertUnique("action ids", request.actionIds);
  assertUnique("verification ids", request.verificationIds);
  assertUnique("blocker refs", request.blockerRefs);
  assertUnique("resolved dependency digests", request.resolvedDependencies.map((artifact) => artifact.digest));
  assertUnique("material decision ids", request.materialDecisions.map((decision) => decision.id));
  if (Date.parse(request.completedAt) > Date.parse(request.requestedAt)) {
    throw new Error("execution completion cannot follow finalization request");
  }
  if (!await verifyContractDigest(request, request.digest)) {
    throw new Error("execution finalization request digest is invalid");
  }
}
async function validateExecutionFinalizationResponse(response, request, envelope) {
  if (response.schemaVersion !== "1.0.0") {
    throw new Error("execution finalization response schema version unsupported");
  }
  if (response.requestId !== request.id || response.requestDigest !== request.digest) {
    throw new Error("execution finalization response does not match its request");
  }
  const resultProof = response.executionResult.proofPacketRef;
  if (!resultProof || resultProof.id !== response.proofPacketRef.id || resultProof.digest !== response.proofPacketRef.digest) {
    throw new Error("execution finalization response proof is inconsistent");
  }
  validateExecutionResult(response.executionResult, envelope);
  if (!await verifyContractDigest(response.executionResult, response.executionResult.digest)) {
    throw new Error("issued execution result digest is invalid");
  }
  if (!await verifyContractDigest(response, response.digest)) {
    throw new Error("execution finalization response digest is invalid");
  }
}
async function computeContractDigest(value) {
  const canonical = canonicalJson(stripTopLevelHashFields(value));
  const bytes = new TextEncoder().encode(canonical);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
async function verifyContractDigest(value, expectedDigest) {
  return await computeContractDigest(value) === expectedDigest;
}
function sameWorkRef(left, right) {
  const keys = [
    "workspaceId",
    "customerId",
    "goalId",
    "objectiveId",
    "initiativeId",
    "workstreamId",
    "milestoneId",
    "taskId"
  ];
  return keys.every((key) => left[key] === right[key]);
}
function assertUnique(label, values) {
  if (new Set(values).size !== values.length) {
    throw new Error(`execution finalization ${label} must be unique`);
  }
}
var HASH_FIELDS = /* @__PURE__ */ new Set([
  "digest",
  "receiptDigest",
  "merkleRoot",
  "signature"
]);
function canonicalJson(value) {
  return JSON.stringify(normalize(value, /* @__PURE__ */ new WeakSet()));
}
function stripTopLevelHashFields(value) {
  if (!isRecord(value))
    return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !HASH_FIELDS.has(key)));
}
function normalize(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    guardCycle(value, seen);
    const normalized = value.map((entry) => normalize(entry, seen));
    seen.delete(value);
    return normalized;
  }
  if (isRecord(value)) {
    guardCycle(value, seen);
    const normalized = Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key], seen)]));
    seen.delete(value);
    return normalized;
  }
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}
function guardCycle(value, seen) {
  if (seen.has(value))
    throw new TypeError("cyclic contract value");
  seen.add(value);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// node_modules/@useorgx/orgx-gateway-sdk/dist/ExecutionFinalizer.js
var ExecutionFinalizationError = class extends Error {
  recoverable;
  status;
  constructor(message, recoverable, status) {
    super(message);
    this.recoverable = recoverable;
    this.status = status;
    this.name = "ExecutionFinalizationError";
  }
};
async function postExecutionFinalization(config, envelope, request) {
  await validateExecutionFinalizationRequest(request, envelope);
  const fetcher = config.fetch ?? globalThis.fetch;
  if (!fetcher) {
    throw new ExecutionFinalizationError("execution finalization requires fetch", true);
  }
  const base = config.baseUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const url = new URL(`/api/v1/runs/${encodeURIComponent(request.runId)}/finalize`, base);
  let response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": request.idempotencyKey
      },
      body: JSON.stringify(request)
    });
  } catch (error) {
    throw new ExecutionFinalizationError(`execution finalization request failed: ${errorMessage(error)}`, true);
  }
  if (!response.ok) {
    throw new ExecutionFinalizationError(`execution finalization failed with ${response.status}`, response.status >= 500 || response.status === 429, response.status);
  }
  const payload = await response.json().catch(() => null);
  if (!isRecord2(payload) || !isRecord2(payload.response)) {
    throw new ExecutionFinalizationError("execution finalization returned an invalid payload", false, response.status);
  }
  const outcome = {
    response: payload.response,
    duplicate: payload.duplicate === true
  };
  try {
    await validateExecutionFinalizationResponse(outcome.response, request, envelope);
  } catch (error) {
    throw new ExecutionFinalizationError(errorMessage(error), false);
  }
  return outcome;
}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// node_modules/@useorgx/orgx-gateway-sdk/dist/protocol.js
var PROTOCOL_VERSION = 1;
function isV2TaskDispatch(message) {
  return "protocol_version" in message && message.protocol_version === 2;
}
function isTaskFinalization(message) {
  return message.kind === "task.finalize";
}

// node_modules/@useorgx/orgx-gateway-sdk/dist/PeerClient.js
var DEFAULT_RECONNECT = {
  // Local peers are supervised daemons. A normal production deploy can last
  // longer than eight attempts, so keep retrying with a capped delay until the
  // gateway returns or the client is stopped explicitly.
  maxAttempts: Number.POSITIVE_INFINITY,
  initialDelayMs: 500,
  maxDelayMs: 3e4,
  jitterRatio: 0.2
};
var IDEMPOTENCY_CACHE_LIMIT = 1e3;
var NON_RETRYABLE_CLOSE_CODES = /* @__PURE__ */ new Set([1e3, 4e3, 4001, 4003, 4401, 4403]);
var RUNNER_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
var PeerClient = class {
  config;
  ws = null;
  state = "idle";
  driversById = /* @__PURE__ */ new Map();
  completedDispatches = /* @__PURE__ */ new Map();
  inFlightDispatches = /* @__PURE__ */ new Map();
  pendingReceipts = /* @__PURE__ */ new Map();
  pendingContinuationReceipts = /* @__PURE__ */ new Map();
  handledAttentionResolutions = /* @__PURE__ */ new Set();
  suspendedDispatches = /* @__PURE__ */ new Map();
  reconnectAttempt = 0;
  reconnectTimer = null;
  manualClose = false;
  constructor(config) {
    this.config = config;
    validateRunnerInstanceId(config.runnerInstanceId);
    for (const driver of config.drivers) {
      this.driversById.set(driver.id, driver);
    }
  }
  get currentState() {
    return this.state;
  }
  get advertisedDrivers() {
    return Array.from(this.driversById.keys());
  }
  connect() {
    if (this.state === "open" || this.state === "connecting")
      return;
    this.manualClose = false;
    this.openSocket();
  }
  disconnect(code = 1e3, reason = "client closing") {
    this.manualClose = true;
    this.clearReconnect();
    if (!this.ws || this.state === "closed") {
      this.state = "closed";
      return;
    }
    this.state = "closing";
    this.ws.close(code, reason);
  }
  send(message) {
    if (this.state !== "open" || !this.ws) {
      throw new Error(`PeerClient.send called while state=${this.state}`);
    }
    this.ws.send(JSON.stringify(message));
  }
  openSocket() {
    this.clearReconnect();
    this.state = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    const url = new URL("/api/v1/gateway/stream", this.config.baseUrl);
    url.searchParams.set("workspace_id", this.config.workspaceId);
    url.searchParams.set("plugin_id", this.config.pluginId);
    url.searchParams.set("drivers", this.advertisedDrivers.join(","));
    if (this.config.installationId) {
      url.searchParams.set("installation_id", this.config.installationId);
    }
    if (this.config.runnerInstanceId !== void 0) {
      url.searchParams.set("runner_instance_id", this.config.runnerInstanceId);
    }
    const protocols = [
      `orgx.v${this.config.protocolVersion ?? PROTOCOL_VERSION}`,
      `bearer.${this.config.apiKey}`
    ];
    const factory = this.config.webSocketFactory ?? ((socketUrl, socketProtocols) => new WebSocket(socketUrl, socketProtocols));
    try {
      const socket = factory(url.toString(), protocols);
      this.ws = socket;
      socket.addEventListener("open", () => {
        if (socket !== this.ws)
          return;
        this.state = "open";
        this.reconnectAttempt = 0;
        this.config.onOpen?.();
        void this.flushPendingReceipts();
      });
      socket.addEventListener("close", (event) => {
        if (socket !== this.ws)
          return;
        this.ws = null;
        const code = event.code ?? 1006;
        const reason = event.reason ?? "";
        this.state = "closed";
        this.config.onClose?.(code, reason);
        if (!this.manualClose && !NON_RETRYABLE_CLOSE_CODES.has(code)) {
          this.scheduleReconnect();
        }
      });
      socket.addEventListener("error", (event) => {
        this.config.onError?.(event);
      });
      socket.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (this.config.onMessage)
            this.config.onMessage(msg);
          else
            void this.defaultHandle(msg);
        } catch (error) {
          this.config.onError?.(error);
        }
      });
    } catch (error) {
      this.ws = null;
      this.state = "closed";
      this.config.onError?.(error);
      this.scheduleReconnect();
    }
  }
  scheduleReconnect() {
    if (this.config.reconnect === false || this.manualClose)
      return;
    const policy = { ...DEFAULT_RECONNECT, ...this.config.reconnect ?? {} };
    if (this.reconnectAttempt >= policy.maxAttempts)
      return;
    this.reconnectAttempt += 1;
    const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (this.reconnectAttempt - 1));
    const random = this.config.random ?? Math.random;
    const jitter = exponential * policy.jitterRatio * (random() * 2 - 1);
    const delayMs = Math.max(0, Math.round(exponential + jitter));
    this.state = "reconnecting";
    this.config.onReconnectScheduled?.(this.reconnectAttempt, delayMs);
    const schedule = this.config.setTimeout ?? globalThis.setTimeout;
    this.reconnectTimer = schedule(() => this.openSocket(), delayMs);
  }
  clearReconnect() {
    if (!this.reconnectTimer)
      return;
    const cancel = this.config.clearTimeout ?? globalThis.clearTimeout;
    cancel(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  async defaultHandle(msg) {
    if (msg.kind === "task.dispatch") {
      if (this.completedDispatches.has(msg.idempotency_key) || this.inFlightDispatches.has(msg.idempotency_key) || this.suspendedDispatches.has(msg.idempotency_key)) {
        return;
      }
      const execution = this.executeDispatch(msg).finally(() => {
        this.inFlightDispatches.delete(msg.idempotency_key);
      });
      this.inFlightDispatches.set(msg.idempotency_key, execution);
      await execution;
      return;
    }
    if (msg.kind === "task.cancel") {
      await Promise.all(Array.from(this.driversById.values()).map((driver) => driver.cancel(msg.run_id).catch(() => void 0)));
      return;
    }
    if (msg.kind === "attention.resolve") {
      await this.resolveAttention(msg);
    }
  }
  async resolveAttention(message) {
    if (this.handledAttentionResolutions.has(message.idempotency_key))
      return;
    this.handledAttentionResolutions.add(message.idempotency_key);
    const baseReceipt = {
      kind: "continuation.receipt",
      protocol_version: 3,
      run_id: message.run_id,
      decision_id: message.decision_id,
      idempotency_key: message.idempotency_key
    };
    if (message.resolution.status === "cancelled") {
      await this.deliverContinuationReceipt({
        ...baseReceipt,
        state: "cancelled",
        ...message.session_handle ? { session_handle: message.session_handle } : {},
        occurred_at: (/* @__PURE__ */ new Date()).toISOString()
      });
      return;
    }
    await this.deliverContinuationReceipt({
      ...baseReceipt,
      state: "answer_received",
      ...message.session_handle ? { session_handle: message.session_handle } : {},
      occurred_at: (/* @__PURE__ */ new Date()).toISOString()
    });
    const candidates = message.driver ? [this.driversById.get(message.driver)].filter((driver2) => Boolean(driver2)) : Array.from(this.driversById.values()).filter((driver2) => typeof driver2.resolveAttention === "function");
    const driver = candidates.length === 1 && candidates[0]?.resolveAttention ? candidates[0] : null;
    if (!driver?.resolveAttention) {
      await this.deliverContinuationReceipt({
        ...baseReceipt,
        state: "resume_failed",
        ...message.session_handle ? { session_handle: message.session_handle } : {},
        detail: candidates.length > 1 ? "Multiple resumable drivers are registered; attention.resolve must name a driver." : "This driver does not implement resumable attention.",
        occurred_at: (/* @__PURE__ */ new Date()).toISOString()
      });
      return;
    }
    let emitted = false;
    try {
      for await (const update of driver.resolveAttention(message)) {
        if ("kind" in update) {
          if (update.run_id !== message.run_id) {
            throw new Error("continuation message run id mismatch");
          }
          if (isTaskFinalization(update)) {
            throw new Error("proof finalization after attention is not supported by this SDK version");
          }
          this.sendSafely(update);
          if (update.kind === "task.completed" || update.kind === "task.failed") {
            this.completeSuspendedRun(message.run_id);
          }
          continue;
        }
        emitted = true;
        await this.deliverContinuationReceipt({
          ...baseReceipt,
          state: update.state,
          ...update.session_handle ?? message.session_handle ? {
            session_handle: update.session_handle ?? message.session_handle
          } : {},
          ...update.detail ? { detail: update.detail } : {},
          occurred_at: update.occurred_at ?? (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      if (!emitted) {
        throw new Error("driver ended without a continuation state");
      }
    } catch (error) {
      await this.deliverContinuationReceipt({
        ...baseReceipt,
        state: "resume_failed",
        ...message.session_handle ? { session_handle: message.session_handle } : {},
        detail: error instanceof Error ? error.message : String(error),
        occurred_at: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
  }
  async executeDispatch(msg) {
    const driver = this.driversById.get(msg.task.driver);
    if (!driver) {
      this.sendSafely({
        kind: "task.failed",
        run_id: msg.run_id,
        reason: `No driver registered for '${msg.task.driver}'`,
        recoverable: false
      });
      return;
    }
    const protocolVersion = isV2TaskDispatch(msg) ? 2 : 1;
    if (isV2TaskDispatch(msg)) {
      try {
        validateExecutionEnvelope(msg.execution_envelope);
        if (msg.execution_envelope.runId !== msg.run_id || msg.execution_envelope.idempotencyKey !== msg.idempotency_key) {
          throw new Error("dispatch identity does not match execution envelope");
        }
      } catch (error) {
        this.sendProtocolFailure(msg.run_id, error);
        return;
      }
    }
    let terminalResult = null;
    let finalization = null;
    let suspended = false;
    let failed = false;
    try {
      for await (const outbound of driver.dispatch(msg.task, {
        run_id: msg.run_id,
        idempotency_key: msg.idempotency_key,
        protocol_version: protocolVersion,
        ...isV2TaskDispatch(msg) ? { execution_envelope: msg.execution_envelope } : {}
      })) {
        if (outbound.kind === "task.suspended") {
          if (terminalResult || finalization || suspended || failed) {
            this.sendProtocolFailure(msg.run_id, new Error("driver emitted multiple terminal or suspended results"));
            return;
          }
          suspended = true;
          this.sendSafely(outbound);
        } else if (outbound.kind === "task.failed") {
          if (terminalResult || finalization || suspended || failed) {
            this.sendProtocolFailure(msg.run_id, new Error("driver emitted multiple terminal or suspended results"));
            return;
          }
          failed = true;
          this.sendSafely(outbound);
        } else if (outbound.kind === "task.completed" || isTaskFinalization(outbound)) {
          if (terminalResult || finalization || suspended || failed) {
            this.sendProtocolFailure(msg.run_id, new Error("driver emitted multiple terminal results"));
            return;
          }
          if (isV2TaskDispatch(msg) !== isTaskFinalization(outbound)) {
            this.sendProtocolFailure(msg.run_id, new Error(`protocol v${protocolVersion} terminal result mismatch`));
            return;
          }
          if (isTaskFinalization(outbound) && isV2TaskDispatch(msg)) {
            if (outbound.run_id !== msg.run_id) {
              this.sendProtocolFailure(msg.run_id, new Error("finalization request run id mismatch"));
              return;
            }
            finalization = outbound;
          } else if (outbound.kind === "task.completed") {
            terminalResult = outbound;
          }
        } else {
          this.sendSafely(outbound);
        }
      }
      if (suspended) {
        this.suspendedDispatches.set(msg.idempotency_key, msg.run_id);
        return;
      }
      if (failed) {
        this.rememberCompleted(msg.idempotency_key, msg.run_id);
        return;
      }
      if (finalization && isV2TaskDispatch(msg)) {
        try {
          const finalized = await postExecutionFinalization(this.config, msg.execution_envelope, finalization.execution_finalization_request);
          terminalResult = {
            kind: "task.result",
            protocol_version: 2,
            run_id: msg.run_id,
            execution_result: finalized.response.executionResult,
            ...finalization.provider_attribution ? { provider_attribution: finalization.provider_attribution } : {}
          };
        } catch (error) {
          this.sendProtocolFailure(msg.run_id, error, error instanceof ExecutionFinalizationError ? error.recoverable : false);
          return;
        }
      }
      if (!terminalResult) {
        this.sendProtocolFailure(msg.run_id, new Error("driver ended without a terminal result"));
        return;
      }
      this.rememberCompleted(msg.idempotency_key, msg.run_id);
      this.pendingReceipts.set(msg.run_id, terminalResult);
      try {
        this.send(terminalResult);
        this.pendingReceipts.delete(msg.run_id);
      } catch (error) {
        this.config.onError?.(error);
        await this.postReceipt(terminalResult);
      }
    } catch (error) {
      this.config.onError?.(error);
      this.sendProtocolFailure(msg.run_id, error, true);
    }
  }
  sendProtocolFailure(runId, error, recoverable = false) {
    this.sendSafely({
      kind: "task.failed",
      run_id: runId,
      reason: error instanceof Error ? error.message : String(error),
      recoverable
    });
  }
  sendSafely(message) {
    try {
      this.send(message);
    } catch (error) {
      this.config.onError?.(error);
    }
  }
  rememberCompleted(idempotencyKey, runId) {
    this.completedDispatches.set(idempotencyKey, runId);
    while (this.completedDispatches.size > IDEMPOTENCY_CACHE_LIMIT) {
      const oldest = this.completedDispatches.keys().next().value;
      if (!oldest)
        break;
      this.completedDispatches.delete(oldest);
    }
  }
  completeSuspendedRun(runId) {
    for (const [idempotencyKey, suspendedRunId] of this.suspendedDispatches) {
      if (suspendedRunId !== runId)
        continue;
      this.suspendedDispatches.delete(idempotencyKey);
      this.rememberCompleted(idempotencyKey, runId);
    }
  }
  async flushPendingReceipts() {
    for (const receipt of this.pendingReceipts.values()) {
      await this.postReceipt(receipt);
    }
    for (const receipt of this.pendingContinuationReceipts.values()) {
      await this.postContinuationReceipt(receipt);
    }
  }
  async postReceipt(receipt) {
    const request = this.config.fetch ?? globalThis.fetch;
    if (!request)
      return;
    const base = this.config.baseUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    const url = new URL(`/api/v1/runs/${encodeURIComponent(receipt.run_id)}/receipt`, base);
    try {
      const response = await request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": receipt.run_id
        },
        body: JSON.stringify(receiptBody(receipt))
      });
      if (!response.ok) {
        throw new Error(`receipt recovery failed with ${response.status}`);
      }
      this.pendingReceipts.delete(receipt.run_id);
    } catch (error) {
      this.config.onError?.(error);
    }
  }
  async deliverContinuationReceipt(receipt) {
    const receiptKey = `${receipt.decision_id}:${receipt.state}`;
    this.pendingContinuationReceipts.set(receiptKey, receipt);
    try {
      this.send(receipt);
    } catch (error) {
      this.config.onError?.(error);
    }
    await this.postContinuationReceipt(receipt);
  }
  async postContinuationReceipt(receipt) {
    const request = this.config.fetch ?? globalThis.fetch;
    if (!request)
      return;
    const base = this.config.baseUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    const url = new URL(`/api/client/live/attention/${encodeURIComponent(receipt.decision_id)}`, base);
    const receiptKey = `${receipt.decision_id}:${receipt.state}`;
    try {
      const response = await request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `${receipt.idempotency_key}:${receipt.state}`
        },
        body: JSON.stringify({
          run_id: receipt.run_id,
          source_client: sourceClientForPlugin(this.config.pluginId),
          state: receipt.state,
          idempotency_key: receipt.idempotency_key,
          session_handle: receipt.session_handle,
          detail: receipt.detail,
          occurred_at: receipt.occurred_at
        })
      });
      if (!response.ok) {
        throw new Error(`continuation receipt recovery failed with ${response.status}`);
      }
      this.pendingContinuationReceipts.delete(receiptKey);
    } catch (error) {
      this.config.onError?.(error);
    }
  }
};
function sourceClientForPlugin(pluginId) {
  if (pluginId === "orgx-codex-plugin")
    return "codex";
  if (pluginId === "orgx-claude-code-plugin")
    return "claude-code";
  return pluginId;
}
function validateRunnerInstanceId(runnerInstanceId) {
  if (runnerInstanceId === void 0)
    return;
  if (typeof runnerInstanceId !== "string" || !RUNNER_INSTANCE_ID_PATTERN.test(runnerInstanceId)) {
    throw new TypeError("PeerClient runnerInstanceId must be 1-160 characters and match /^[A-Za-z0-9][A-Za-z0-9._:-]*$/");
  }
}
function receiptBody(receipt) {
  if (receipt.kind === "task.result") {
    return {
      protocol_version: 2,
      execution_result: receipt.execution_result,
      provider_attribution: receipt.provider_attribution ?? null,
      outcome_kind: receipt.execution_result.disposition,
      completed_at: receipt.execution_result.completedAt,
      metadata: { recovered_from: "gateway_socket" }
    };
  }
  return {
    provider: receipt.provider,
    source_sub_type: receipt.source_sub_type,
    source_driver: receipt.source_driver,
    started_at: receipt.started_at,
    first_response_at: receipt.first_response_at ?? null,
    completed_at: receipt.completed_at,
    tokens_used: receipt.tokens_used,
    cost_estimate_cents: receipt.cost_estimate_cents,
    saved_estimate_cents: receipt.saved_estimate_cents ?? 0,
    outcome_kind: receipt.outcome_kind,
    metadata: { recovered_from: "gateway_socket" }
  };
}
export {
  PeerClient
};
