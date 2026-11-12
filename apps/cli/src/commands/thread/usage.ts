import { readdir, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import {
  parseUserManagerCgroup,
  THREAD_CGROUP_SLICE_PATH,
  threadIdFromScopeUnitName,
} from "@bb/config/thread-cgroups";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import {
  columnWidths,
  printBorderlessTable,
  truncateCell,
} from "../../table.js";
import { outputJson } from "../helpers.js";

const CPU_SAMPLE_MS = 1_000;
const TITLE_TIMEOUT_MS = 2_000;
const TITLE_WIDTH = 40;
const GIB = 1024 ** 3;
const SCOPE_FILES = [
  "cpu.stat",
  "cpu.max",
  "memory.current",
  "memory.high",
  "pids.current",
] as const;

export interface ThreadUsage {
  threadId: string;
  title: string | null;
  cpuCores: number;
  cpuQuotaCores: number | null;
  memoryBytes: number;
  memoryHighBytes: number | null;
  pids: number;
}

type ScopeFile = (typeof SCOPE_FILES)[number];
type ThreadTotals = Omit<ThreadUsage, "title">;
export type ScopeReading = Omit<ThreadTotals, "cpuCores"> & {
  cpuUsageUsec: number;
};

const limit = (text: string | undefined): number | null => {
  const [value, period] = (text ?? "max").trim().split(/\s+/u);
  return value === undefined || value === "max"
    ? null
    : Number(value) / Number(period ?? 1);
};

const addLimits = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a + b;

export function parseScopeFiles(
  threadId: string,
  files: ReadonlyMap<string, string>,
): ScopeReading {
  const usage = /^usage_usec (\d+)$/mu.exec(files.get("cpu.stat") ?? "")?.[1];
  return {
    threadId,
    cpuUsageUsec: Number(usage ?? 0),
    cpuQuotaCores: limit(files.get("cpu.max")),
    memoryBytes: limit(files.get("memory.current")) ?? 0,
    memoryHighBytes: limit(files.get("memory.high")),
    pids: limit(files.get("pids.current")) ?? 0,
  };
}

export function aggregateThreadUsage(args: {
  before: Map<string, ScopeReading>;
  after: Map<string, ScopeReading>;
  elapsedMs: number;
}): ThreadTotals[] {
  const threads = new Map<string, ThreadTotals>();
  for (const [scope, reading] of args.after) {
    const before = args.before.get(scope)?.cpuUsageUsec;
    const startUsec =
      before === undefined
        ? reading.cpuUsageUsec
        : before > reading.cpuUsageUsec
          ? 0
          : before;
    const total = threads.get(reading.threadId) ?? {
      threadId: reading.threadId,
      cpuCores: 0,
      cpuQuotaCores: 0,
      memoryBytes: 0,
      memoryHighBytes: 0,
      pids: 0,
    };
    threads.set(reading.threadId, {
      threadId: reading.threadId,
      cpuCores:
        total.cpuCores +
        (reading.cpuUsageUsec - startUsec) / 1_000 / args.elapsedMs,
      cpuQuotaCores: addLimits(total.cpuQuotaCores, reading.cpuQuotaCores),
      memoryBytes: total.memoryBytes + reading.memoryBytes,
      memoryHighBytes: addLimits(
        total.memoryHighBytes,
        reading.memoryHighBytes,
      ),
      pids: total.pids + reading.pids,
    });
  }
  return [...threads.values()].sort(
    (a, b) => b.cpuCores - a.cpuCores || b.memoryBytes - a.memoryBytes,
  );
}

async function threadSliceDir(): Promise<string> {
  const uid = process.getuid?.() ?? 0;
  const managerPath =
    parseUserManagerCgroup(
      await readFile("/proc/self/cgroup", "utf8").catch(() => ""),
    )?.managerPath ?? `/user.slice/user-${uid}.slice/user@${uid}.service`;
  return `/sys/fs/cgroup${managerPath}/${THREAD_CGROUP_SLICE_PATH}`;
}

async function readScopes(
  sliceDir: string,
): Promise<Map<string, ScopeReading>> {
  const readings = new Map<string, ScopeReading>();
  const entries = await readdir(sliceDir).catch(() => []);
  for (const scope of entries) {
    const threadId = threadIdFromScopeUnitName(scope);
    if (threadId === null) continue;
    const files = new Map<ScopeFile, string>();
    for (const file of SCOPE_FILES) {
      const text = await readFile(`${sliceDir}/${scope}/${file}`, "utf8").catch(
        () => null,
      );
      if (text !== null) files.set(file, text);
    }
    if (files.has("cpu.stat")) {
      readings.set(scope, parseScopeFiles(threadId, files));
    }
  }
  return readings;
}

const formatBytes = (bytes: number | null) =>
  bytes === null
    ? "max"
    : bytes >= GIB
      ? `${(bytes / GIB).toFixed(1)}G`
      : `${Math.round(bytes / 1024 ** 2)}M`;

function printThreadUsage(usage: ThreadUsage[]): void {
  const rows = usage.map((thread) => [
    thread.threadId,
    truncateCell(thread.title ?? "", TITLE_WIDTH),
    thread.cpuCores.toFixed(1),
    thread.cpuQuotaCores === null ? "max" : String(thread.cpuQuotaCores),
    formatBytes(thread.memoryBytes),
    formatBytes(thread.memoryHighBytes),
    String(thread.pids),
  ]);
  const head = ["Thread", "Title", "CPU", "Quota", "Memory", "High", "PIDs"];
  printBorderlessTable(
    {
      head,
      colWidths: columnWidths(
        rows,
        head.map((column) => column.length),
      ),
    },
    rows,
  );
  const cores = usage.reduce((total, thread) => total + thread.cpuCores, 0);
  const memory = usage.reduce((total, thread) => total + thread.memoryBytes, 0);
  console.log(
    `${usage.length} threads: ${cores.toFixed(1)} cores, ${formatBytes(memory)} memory`,
  );
}

export function registerUsageCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("usage")
    .description(
      "Show CPU and memory per thread on this machine, from each thread's cgroup (Linux)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: { json?: boolean }) => {
        const sliceDir = await threadSliceDir();
        const before = await readScopes(sliceDir);
        const startedAt = Date.now();
        if (before.size > 0) await sleep(CPU_SAMPLE_MS);
        const after = await readScopes(sliceDir);
        const totals = aggregateThreadUsage({
          before,
          after,
          elapsedMs: Math.max(1, Date.now() - startedAt),
        });
        const sdk = createCliBbSdk(getUrl());
        const signal = AbortSignal.timeout(TITLE_TIMEOUT_MS);
        const usage: ThreadUsage[] = await Promise.all(
          totals.map(async (thread) => ({
            ...thread,
            title: await sdk.threads
              .get({ threadId: thread.threadId, signal })
              .then((result) => result.title ?? null)
              .catch(() => null),
          })),
        );
        if (outputJson(opts, usage)) return;
        if (usage.length === 0) {
          console.log("No thread cgroups on this machine");
          return;
        }
        printThreadUsage(usage);
      }),
    );
}
