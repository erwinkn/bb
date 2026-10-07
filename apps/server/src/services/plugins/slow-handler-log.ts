import type { ServerLogger } from "../../types.js";

const SLOW_HANDLER_THRESHOLD_MS = 5_000;
const SLOW_HANDLER_LOG_INTERVAL_MS = 10_000;
const SLOW_HANDLER_MAX_TRACKED = 1_000;

interface SuppressedSlowHandler {
  pluginId: string;
  handler: string;
  count: number;
  maxDurationMs: number;
}

export interface SlowHandlerLog {
  record(pluginId: string, handler: string, durationMs: number): void;
}

export function createSlowHandlerLog(
  logger: Pick<ServerLogger, "warn">,
): SlowHandlerLog {
  const lastLoggedAt = new Map<string, number>();
  const suppressed = new Map<string, SuppressedSlowHandler>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function warn(fields: Record<string, unknown>, message: string): void {
    try {
      logger.warn(fields, message);
    } catch {}
  }

  function markLogged(key: string, at: number): void {
    lastLoggedAt.delete(key);
    lastLoggedAt.set(key, at);
    while (lastLoggedAt.size > SLOW_HANDLER_MAX_TRACKED) {
      const oldest = lastLoggedAt.keys().next().value;
      if (oldest === undefined) break;
      lastLoggedAt.delete(oldest);
    }
  }

  function flush(): void {
    flushTimer = null;
    const at = Date.now();
    const entries = [...suppressed];
    suppressed.clear();
    for (const [key] of entries) markLogged(key, at);
    for (const [, entry] of entries) {
      warn(
        {
          pluginId: entry.pluginId,
          handler: entry.handler,
          suppressed: entry.count,
          maxDurationMs: Math.round(entry.maxDurationMs),
        },
        "Slow plugin handler calls suppressed",
      );
    }
  }

  return {
    record(pluginId, handler, durationMs) {
      if (durationMs < SLOW_HANDLER_THRESHOLD_MS) return;
      const key = `${pluginId}\u0000${handler}`;
      const at = Date.now();
      const last = lastLoggedAt.get(key);
      if (last === undefined || at - last >= SLOW_HANDLER_LOG_INTERVAL_MS) {
        markLogged(key, at);
        warn(
          { pluginId, handler, durationMs: Math.round(durationMs) },
          "Slow plugin handler",
        );
        return;
      }
      const entry = suppressed.get(key);
      if (entry === undefined) {
        suppressed.set(key, {
          pluginId,
          handler,
          count: 1,
          maxDurationMs: durationMs,
        });
      } else {
        entry.count += 1;
        entry.maxDurationMs = Math.max(entry.maxDurationMs, durationMs);
      }
      if (flushTimer === null) {
        flushTimer = setTimeout(
          flush,
          last + SLOW_HANDLER_LOG_INTERVAL_MS - at,
        );
        flushTimer.unref?.();
      }
    },
  };
}
