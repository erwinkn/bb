import type { TunnelClientLogger } from "./logger.js";

const SLOW_HTTP_REQUEST_MS = 5_000;
const RELAY_RESPONSE_HEAD_TIMEOUT_MS = 30_000;
const REQUEST_LOG_INTERVAL_MS = 10_000;
const REQUEST_LOG_MAX_TRACKED = 1_000;

export interface FinishedHttpRequest {
  method: string;
  path: string;
  status: number | null;
  originTtfbMs: number | null;
  totalMs: number;
  relayCloseReason: string | null;
}

interface SuppressedRequests {
  label: string;
  count: number;
  maxTotalMs: number;
}

export interface HttpRequestLog {
  record(request: FinishedHttpRequest): void;
  dispose(): void;
}

function roundMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

export function pathWithoutQuery(path: string): string {
  const queryStart = path.indexOf("?");
  return queryStart === -1 ? path : path.slice(0, queryStart);
}

function describe(request: FinishedHttpRequest, label: string): string {
  const fields = [
    label,
    `status=${request.status ?? "none"}`,
    `originTtfbMs=${request.originTtfbMs === null ? "none" : roundMs(request.originTtfbMs)}`,
    `totalMs=${roundMs(request.totalMs)}`,
  ];
  if (
    (request.originTtfbMs ?? request.totalMs) >= RELAY_RESPONSE_HEAD_TIMEOUT_MS
  ) {
    fields.push("relayTimedOut=true");
  }
  if (request.relayCloseReason !== null) {
    fields.push(`reason=${JSON.stringify(request.relayCloseReason)}`);
  }
  return fields.join(" ");
}

export function createHttpRequestLog(log: TunnelClientLogger): HttpRequestLog {
  const lastLoggedAt = new Map<string, number>();
  const suppressed = new Map<string, SuppressedRequests>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function warn(line: string): void {
    try {
      log.warn(line);
    } catch {}
  }

  function markLogged(label: string, at: number): void {
    lastLoggedAt.delete(label);
    lastLoggedAt.set(label, at);
    while (lastLoggedAt.size > REQUEST_LOG_MAX_TRACKED) {
      const oldest = lastLoggedAt.keys().next().value;
      if (oldest === undefined) break;
      lastLoggedAt.delete(oldest);
    }
  }

  function flush(): void {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    const at = Date.now();
    const entries = [...suppressed.values()];
    suppressed.clear();
    for (const entry of entries) markLogged(entry.label, at);
    for (const entry of entries) {
      warn(
        `${entry.label} suppressed=${entry.count} maxTotalMs=${roundMs(entry.maxTotalMs)}`,
      );
    }
  }

  function record(request: FinishedHttpRequest): void {
    const relayCancelled = request.relayCloseReason !== null;
    if (!relayCancelled && request.totalMs < SLOW_HTTP_REQUEST_MS) return;
    const label = [
      relayCancelled
        ? "bb connect request cancelled by relay"
        : "bb connect slow request",
      `method=${request.method}`,
      `path=${pathWithoutQuery(request.path)}`,
    ].join(" ");
    const at = Date.now();
    const last = lastLoggedAt.get(label);
    if (last === undefined || at - last >= REQUEST_LOG_INTERVAL_MS) {
      markLogged(label, at);
      warn(describe(request, label));
      return;
    }
    const entry = suppressed.get(label);
    if (entry === undefined) {
      suppressed.set(label, { label, count: 1, maxTotalMs: request.totalMs });
    } else {
      entry.count += 1;
      entry.maxTotalMs = Math.max(entry.maxTotalMs, request.totalMs);
    }
    if (flushTimer === null) {
      flushTimer = setTimeout(flush, last + REQUEST_LOG_INTERVAL_MS - at);
      flushTimer.unref?.();
    }
  }

  return { record, dispose: flush };
}
