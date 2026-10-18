import { ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import type { DbQueryTiming } from "@bb/db";
import { roundDurationMs } from "@bb/process-utils";
import { getCurrentEventLoopWorkLabel } from "./event-loop-work.js";

const UNLABELLED_WORK = "(unlabelled)";
const TOP_DB_WORK_COUNT = 3;
const MAX_SQL_LENGTH = 300;
const SQL_STRING_LITERAL_PATTERN = /'(?:''|[^'])*'/gu;
const SQL_WHITESPACE_PATTERN = /\s+/gu;
const RECENT_SPAWN_LIMIT = 256;

interface AttributionWindow {
  dbByWork: Map<string, number>;
  dbCount: number;
  dbMs: number;
  gcCount: number;
  gcMaxMs: number;
  gcMs: number;
  slowestQueryMs: number;
  slowestQuerySource: string | null;
  slowestSpawn: string | null;
  spawnCount: number;
  spawnMaxMs: number;
  spawnMs: number;
  startedAt: number;
  threadCpu: NodeJS.CpuUsage;
}

interface RecentSpawn {
  durationMs: number;
  endedAt: number;
}

export interface SpawnSummary {
  spawnCount: number;
  spawnMs: number;
}

export interface EventLoopAttributionSnapshot {
  dbMs: number;
  dbQueries: number;
  dbTopWork: string | null;
  gcMaxMs: number;
  gcMs: number;
  gcPauses: number;
  mainThreadCpuMs: number;
  slowestQuery: string | null;
  slowestQueryMs: number;
  slowestSpawn: string | null;
  spawnCount: number;
  spawnMaxMs: number;
  spawnMs: number;
  windowMs: number;
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
    slowestSpawn: null,
    spawnCount: 0,
    spawnMaxMs: 0,
    spawnMs: 0,
    startedAt: performance.now(),
    threadCpu: process.threadCpuUsage(),
  };
}

let current = emptyWindow();
const recentSpawns: RecentSpawn[] = [];

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

export function recordEventLoopSpawn(durationMs: number, file: string): void {
  current.spawnCount += 1;
  current.spawnMs += durationMs;
  if (durationMs > current.spawnMaxMs) {
    current.spawnMaxMs = durationMs;
    current.slowestSpawn = basename(file);
  }
  recentSpawns.push({ durationMs, endedAt: Date.now() });
  if (recentSpawns.length > RECENT_SPAWN_LIMIT) recentSpawns.shift();
}

export function summarizeSpawnsBetween(
  startedAt: number,
  endedAt: number,
): SpawnSummary {
  let spawnCount = 0;
  let spawnMs = 0;
  for (const spawn of recentSpawns) {
    if (spawn.endedAt < startedAt || spawn.endedAt > endedAt) continue;
    spawnCount += 1;
    spawnMs += spawn.durationMs;
  }
  return { spawnCount, spawnMs: roundDurationMs(spawnMs) };
}

export function startSpawnAttribution(): () => void {
  const prototype = ChildProcess.prototype as ChildProcess & {
    spawn: (options: { file?: string }) => unknown;
  };
  const original = prototype.spawn;
  prototype.spawn = function timedSpawn(
    this: ChildProcess,
    options: { file?: string },
  ) {
    const startedAt = performance.now();
    try {
      return original.call(this, options);
    } finally {
      recordEventLoopSpawn(
        performance.now() - startedAt,
        options?.file ?? "(unknown)",
      );
    }
  };
  return () => {
    prototype.spawn = original;
  };
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
  const threadCpu = process.threadCpuUsage(window.threadCpu);
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
    mainThreadCpuMs: roundDurationMs(
      (threadCpu.user + threadCpu.system) / 1_000,
    ),
    slowestQuery:
      window.slowestQuerySource === null
        ? null
        : formatSql(window.slowestQuerySource),
    slowestQueryMs: roundDurationMs(window.slowestQueryMs),
    slowestSpawn: window.slowestSpawn,
    spawnCount: window.spawnCount,
    spawnMaxMs: roundDurationMs(window.spawnMaxMs),
    spawnMs: roundDurationMs(window.spawnMs),
    windowMs: roundDurationMs(current.startedAt - window.startedAt),
  };
}
