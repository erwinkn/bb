import { PerformanceObserver } from "node:perf_hooks";
import type { DbQueryTiming } from "@bb/db";
import { roundDurationMs } from "@bb/process-utils";
import { getCurrentEventLoopWorkLabel } from "./event-loop-work.js";

const UNLABELLED_WORK = "(unlabelled)";
const TOP_DB_WORK_COUNT = 3;
const MAX_SQL_LENGTH = 300;
const SQL_STRING_LITERAL_PATTERN = /'(?:''|[^'])*'/gu;
const SQL_WHITESPACE_PATTERN = /\s+/gu;

interface AttributionWindow {
  dbByWork: Map<string, number>;
  dbCount: number;
  dbMs: number;
  gcCount: number;
  gcMaxMs: number;
  gcMs: number;
  slowestQueryMs: number;
  slowestQuerySource: string | null;
}

export interface EventLoopAttributionSnapshot {
  dbMs: number;
  dbQueries: number;
  dbTopWork: string | null;
  gcMaxMs: number;
  gcMs: number;
  gcPauses: number;
  slowestQuery: string | null;
  slowestQueryMs: number;
}

function emptyWindow(): AttributionWindow {
  return {
    dbByWork: new Map(),
    dbCount: 0,
    dbMs: 0,
    gcCount: 0,
    gcMaxMs: 0,
    gcMs: 0,
    slowestQueryMs: 0,
    slowestQuerySource: null,
  };
}

let current = emptyWindow();

function formatSql(source: string): string {
  const normalized = source
    .replace(SQL_STRING_LITERAL_PATTERN, "'?'")
    .replace(SQL_WHITESPACE_PATTERN, " ")
    .trim();
  return normalized.length <= MAX_SQL_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_SQL_LENGTH)}...`;
}

export function recordEventLoopDbQuery(timing: DbQueryTiming): void {
  current.dbCount += 1;
  current.dbMs += timing.durationMs;
  const work = getCurrentEventLoopWorkLabel() ?? UNLABELLED_WORK;
  current.dbByWork.set(
    work,
    (current.dbByWork.get(work) ?? 0) + timing.durationMs,
  );
  if (timing.durationMs > current.slowestQueryMs) {
    current.slowestQueryMs = timing.durationMs;
    current.slowestQuerySource = timing.source;
  }
}

export function startGcAttribution(): () => void {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      current.gcCount += 1;
      current.gcMs += entry.duration;
      current.gcMaxMs = Math.max(current.gcMaxMs, entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  return () => observer.disconnect();
}

export function takeEventLoopAttributionWindow(): EventLoopAttributionSnapshot {
  const window = current;
  current = emptyWindow();
  const topWork = [...window.dbByWork]
    .sort((left, right) => right[1] - left[1])
    .slice(0, TOP_DB_WORK_COUNT)
    .map(([work, ms]) => `${work} ${roundDurationMs(ms)}ms`);
  return {
    dbMs: roundDurationMs(window.dbMs),
    dbQueries: window.dbCount,
    dbTopWork: topWork.length === 0 ? null : topWork.join(" | "),
    gcMaxMs: roundDurationMs(window.gcMaxMs),
    gcMs: roundDurationMs(window.gcMs),
    gcPauses: window.gcCount,
    slowestQuery:
      window.slowestQuerySource === null
        ? null
        : formatSql(window.slowestQuerySource),
    slowestQueryMs: roundDurationMs(window.slowestQueryMs),
  };
}
