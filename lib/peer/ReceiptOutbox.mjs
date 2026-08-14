import {
  OUTBOX_SCHEMA_VERSION,
  auditUnresolvedReservations,
  ensureOutboxDirectory,
  listReceiptEntries,
  persistReceiptEntry,
  persistReservationMarker,
  removeOutboxFile,
  removeReservationMarker,
  resolveReceiptOutboxPath,
} from './ReceiptOutboxStorage.mjs';

const DEFAULT_RECEIPT_TIMEOUT_MS = 5_000;

export class TerminalReceiptOutbox {
  constructor(opts) {
    this.directory = resolveReceiptOutboxPath(opts);
    this.baseUrl = requiredString(opts.baseUrl, 'OrgX base URL');
    this.apiKey = requiredString(opts.apiKey, 'OrgX API key');
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.logger = opts.logger ?? console;
    this.timeoutMs = positiveInteger(
      opts.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
      'Receipt timeout'
    );
    this.persistReceipt = opts.persistReceipt ?? persistReceiptEntry;
    this.persistReservation =
      opts.persistReservation ?? persistReservationMarker;
    this.pendingMemory = new Map();
    this.chain = Promise.resolve();
  }

  prepare() {
    return this.queue(async () => {
      await ensureOutboxDirectory(this.directory);
      await auditUnresolvedReservations(this.directory);
    });
  }

  reserve(started) {
    return this.queue(() => this.persistReservation(this.directory, started));
  }

  deliver(message) {
    return this.queue(async () => {
      const entry = entryFromCompletion(message);
      const path = await this.persistReceipt(this.directory, entry);
      await removeReservationMarker(this.directory, entry.run_id);
      const delivered = await this.post(entry);
      if (delivered) await removeOutboxFile(path);
      return { delivered, path };
    });
  }

  retain(message, error) {
    this.pendingMemory.set(message.run_id, message);
    this.warn(
      'receipt retained in memory after local persistence failed',
      error
    );
  }

  recoverWithoutReservation(message) {
    this.pendingMemory.set(message.run_id, message);
    return this.queue(async () => {
      const delivered = await this.post(entryFromCompletion(message));
      if (delivered) {
        await this.clearReservation(message.run_id);
        this.pendingMemory.delete(message.run_id);
      }
      return delivered;
    });
  }

  clearReservation(runId) {
    return removeReservationMarker(this.directory, runId);
  }

  replay() {
    return this.queue(async () => {
      await ensureOutboxDirectory(this.directory);
      let delivered = 0;
      let retained = 0;
      const handledPaths = new Set();

      for (const message of [...this.pendingMemory.values()]) {
        const entry = entryFromCompletion(message);
        try {
          const path = await this.persistReceipt(this.directory, entry);
          handledPaths.add(path);
          await removeReservationMarker(this.directory, entry.run_id);
          this.pendingMemory.delete(entry.run_id);
          if (await this.post(entry)) {
            await removeOutboxFile(path);
            delivered += 1;
          } else {
            retained += 1;
          }
        } catch (error) {
          retained += 1;
          this.warn('in-memory receipt retry could not persist', error);
        }
      }

      let entries;
      try {
        entries = await listReceiptEntries(this.directory);
      } catch (error) {
        this.warn('receipt outbox entries could not be listed', error);
        return { delivered, retained: retained + 1 };
      }
      for (const { path, entry } of entries) {
        if (handledPaths.has(path)) continue;
        if (await this.post(entry)) {
          await removeOutboxFile(path);
          delivered += 1;
        } else {
          retained += 1;
        }
      }
      return { delivered, retained };
    });
  }

  flush() {
    return this.chain.catch(() => undefined);
  }

  queue(operation) {
    const pending = this.chain.catch(() => undefined).then(operation);
    this.chain = pending;
    return pending;
  }

  async post(entry) {
    if (typeof this.fetch !== 'function') {
      this.warn('receipt outbox has no fetch implementation');
      return false;
    }
    const url = new URL(
      `/api/v1/runs/${encodeURIComponent(entry.run_id)}/receipt`,
      this.baseUrl
    );
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': entry.run_id,
        },
        body: JSON.stringify(entry.receipt),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const status = Number(response?.status);
      if (status >= 200 && status < 300) return true;
      this.warn(`receipt recovery failed with status ${String(status)}`);
      return false;
    } catch (error) {
      this.warn('receipt recovery request failed', error);
      return false;
    }
  }

  warn(message, error) {
    this.logger.warn?.(
      `[orgx-deepseek-harness] ${message}`,
      error instanceof Error ? error.message : undefined
    );
  }
}

export class ReceiptOutboxDriver {
  constructor(driver, outbox) {
    if (!driver || typeof driver.dispatch !== 'function') {
      throw new TypeError('Receipt outbox driver requires a driver');
    }
    if (!outbox || typeof outbox.deliver !== 'function') {
      throw new TypeError('Receipt outbox driver requires an outbox');
    }
    this.inner = driver;
    this.outbox = outbox;
    this.id = driver.id;
  }

  detect() {
    return this.inner.detect();
  }

  probe() {
    return this.inner.probe();
  }

  cancel(runId) {
    return this.inner.cancel(runId);
  }

  async *dispatch(task, context) {
    const iterator = this.inner.dispatch(task, context)[Symbol.asyncIterator]();
    let finished = false;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          return;
        }
        const message = next.value;
        if (message?.kind === 'task.started') {
          try {
            await this.outbox.reserve(message);
          } catch (error) {
            await iterator.return?.();
            finished = true;
            const blocked = reservationFailureCompletion(message);
            this.outbox.retain(blocked, error);
            await Promise.resolve(
              this.outbox.recoverWithoutReservation(blocked)
            ).catch((recoveryError) => {
              this.outbox.retain(blocked, recoveryError);
            });
            yield blocked;
            return;
          }
        } else if (message?.kind === 'task.completed') {
          try {
            await this.outbox.deliver(message);
          } catch (error) {
            // Never replace an already-produced completion with task.failed.
            // Try the bound HTTP receipt immediately; if it also fails, the
            // in-memory queue retries on the next 15-second peer tick.
            this.outbox.retain(message, error);
            await Promise.resolve(
              this.outbox.recoverWithoutReservation(message)
            ).catch((recoveryError) => {
              this.outbox.retain(message, recoveryError);
            });
          }
        }
        yield message;
      }
    } finally {
      if (!finished) await iterator.return?.();
    }
  }
}

export function entryFromCompletion(message) {
  if (!message || message.kind !== 'task.completed') {
    throw new TypeError('Receipt outbox accepts only task.completed messages');
  }
  const runId = requiredString(message.run_id, 'OrgX run id');
  return {
    schema_version: OUTBOX_SCHEMA_VERSION,
    run_id: runId,
    receipt: {
      provider: message.provider,
      source_sub_type: message.source_sub_type,
      source_driver: message.source_driver,
      started_at: message.started_at,
      first_response_at: message.first_response_at ?? null,
      completed_at: message.completed_at,
      tokens_used: message.tokens_used,
      cost_estimate_cents: message.cost_estimate_cents,
      saved_estimate_cents: message.saved_estimate_cents ?? 0,
      outcome_kind: message.outcome_kind,
      metadata: { recovered_from: 'deepseek_harness_receipt_outbox' },
    },
  };
}

function reservationFailureCompletion(started) {
  return {
    kind: 'task.completed',
    run_id: started.run_id,
    outcome_kind: 'blocked',
    started_at: started.started_at,
    completed_at: new Date().toISOString(),
    tokens_used: 0,
    provider: 'other',
    source_sub_type: 'api_key',
    source_driver: 'deepseek_harness',
    cost_estimate_cents: 0,
  };
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

export {
  DEFAULT_RECEIPT_TIMEOUT_MS,
  OUTBOX_SCHEMA_VERSION,
  resolveReceiptOutboxPath,
};
