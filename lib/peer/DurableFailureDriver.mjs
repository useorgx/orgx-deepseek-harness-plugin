/**
 * Adapt post-start driver failures to a durable terminal receipt.
 *
 * orgx-gateway-sdk 0.1.0-alpha.9 can recover task.completed over the HTTP
 * receipt endpoint when its socket drops, but task.failed is socket-only. A
 * failure after task.started is therefore represented as a terminal completion
 * so the run cannot remain active solely because the terminal frame was lost.
 * Cancellation maps to abandoned; other execution failures map to blocked.
 * Pre-start failures (notably duplicate-run rejection) remain task.failed and
 * never terminalize another dispatch that already owns the same run id.
 */

const MAX_FAILURE_SUMMARY_CHARS = 2_000;

export class DurableFailureDriver {
  constructor(driver) {
    if (!driver || typeof driver.dispatch !== 'function') {
      throw new TypeError('Durable failure driver requires a driver');
    }
    this.inner = driver;
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
    let started;
    try {
      for await (const message of this.inner.dispatch(task, context)) {
        if (message?.kind === 'task.started') started = message;
        if (message?.kind === 'task.failed' && started) {
          yield* durableTerminalMessages(message, started);
          return;
        }
        yield message;
      }
    } catch (error) {
      if (!started) throw error;
      yield* durableTerminalMessages(
        {
          run_id: started.run_id,
          reason: error instanceof Error ? error.message : String(error),
        },
        started
      );
    }
  }
}

function* durableTerminalMessages(failure, started) {
  const reason = safeSummary(failure.reason);
  const outcomeKind =
    reason === 'DeepSeek Harness run cancelled' ? 'abandoned' : 'blocked';
  yield {
    kind: 'task.step',
    run_id: started.run_id,
    step: {
      kind: 'chat',
      summary: `Execution ${outcomeKind}: ${reason}`,
    },
  };
  yield {
    kind: 'task.completed',
    run_id: started.run_id,
    outcome_kind: outcomeKind,
    started_at: started.started_at,
    completed_at: new Date().toISOString(),
    // The pinned Harness headless surface exposes no usage accounting. OrgX
    // canonicalizes the persisted estimate server-side.
    tokens_used: 0,
    provider: 'other',
    source_sub_type: 'api_key',
    source_driver: 'deepseek_harness',
    cost_estimate_cents: 0,
  };
}

function safeSummary(value) {
  const text =
    typeof value === 'string' && value.trim()
      ? value.trim()
      : 'DeepSeek Harness failed without a reason';
  if (text.length <= MAX_FAILURE_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_FAILURE_SUMMARY_CHARS - 1)}…`;
}

export { durableTerminalMessages };
