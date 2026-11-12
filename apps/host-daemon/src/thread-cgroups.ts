import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  isUnitSafeThreadId,
  parseUserManagerCgroup,
  THREAD_CGROUP_SLICE,
  threadScopeUnitName,
} from "@bb/config/thread-cgroups";
import type { HostDaemonLogger } from "./logger.js";

const SWEEP_INTERVAL_MS = 1_000;
const PLACEMENT_ATTEMPTS = 30;
const UNTAGGED_RECHECKS = 3;
const BUSCTL_TIMEOUT_MS = 5_000;
const CPU_QUOTA_PER_SEC_USEC = 8_000_000;
const MEMORY_HIGH_BYTES = 16 * 1024 ** 3;
const SCOPE_STOP_TIMEOUT_USEC = 2_000_000;
const WARN_INTERVAL_MS = 60_000;
const STAT_START_TIME_INDEX = 19;
const execFileAsync = promisify(execFile);

interface ThreadCgroupsOptions {
  logger: Pick<HostDaemonLogger, "info" | "warn">;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  selfPid?: number;
  intervalMs?: number;
  readText?: (path: string) => Promise<string>;
  busctl?: (args: string[]) => Promise<void>;
}

export interface ThreadCgroups {
  sweep: () => Promise<void>;
  stop: () => void;
}

export function threadIdFromEnviron(environ: string): string | null {
  const entry = environ
    .split("\0")
    .find((variable) => variable.startsWith("BB_THREAD_ID="));
  const threadId = entry?.slice("BB_THREAD_ID=".length) ?? "";
  return isUnitSafeThreadId(threadId) ? threadId : null;
}

function managerCall(method: string, ...args: (string | number)[]): string[] {
  return [
    "--user",
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    method,
    ...args.map(String),
  ];
}

export function attachScopeArgs(threadId: string, pids: number[]): string[] {
  const unit = threadScopeUnitName(threadId);
  return managerCall(
    "AttachProcessesToUnit",
    "ssau",
    unit,
    "/",
    pids.length,
    ...pids,
  );
}

export function startScopeArgs(args: {
  threadId: string;
  pids: number[];
  ownUnit: string;
}): string[] {
  const properties: (string | number)[][] = [
    ["PIDs", "au", args.pids.length, ...args.pids],
    ["Slice", "s", THREAD_CGROUP_SLICE],
    ["Description", "s", `BB thread ${args.threadId}`],
    ["Delegate", "b", "true"],
    ["OOMPolicy", "s", "continue"],
    ["CPUQuotaPerSecUSec", "t", CPU_QUOTA_PER_SEC_USEC],
    ["MemoryHigh", "t", MEMORY_HIGH_BYTES],
    ["TimeoutStopUSec", "t", SCOPE_STOP_TIMEOUT_USEC],
    ["CollectMode", "s", "inactive-or-failed"],
    ["StopPropagatedFrom", "as", 1, args.ownUnit],
    ["Before", "as", 1, args.ownUnit],
  ];
  return managerCall(
    "StartTransientUnit",
    "ssa(sv)a(sa(sv))",
    threadScopeUnitName(args.threadId),
    "fail",
    properties.length,
    ...properties.flat(),
    0,
  );
}

async function runBusctl(args: string[]): Promise<void> {
  await execFileAsync("busctl", args, { timeout: BUSCTL_TIMEOUT_MS });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String(error.stderr).trim();
    if (stderr !== "") return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

export function startThreadCgroups(
  options: ThreadCgroupsOptions,
): ThreadCgroups | null {
  const env = options.env ?? process.env;
  const readText =
    options.readText ?? ((path: string) => readFile(path, "utf8"));
  const busctl = options.busctl ?? runBusctl;
  const selfPid = options.selfPid ?? process.pid;
  const lastWarned = new Map<string, number>();
  let attemptsLeft = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  if ((options.platform ?? process.platform) !== "linux") return null;
  if (env.BB_THREAD_CGROUPS === "0") {
    options.logger.info("Thread cgroups disabled by BB_THREAD_CGROUPS=0");
    return null;
  }
  if (env.BB_THREAD_ID !== undefined) {
    options.logger.info(
      "Thread cgroups disabled: this daemon runs inside a BB thread",
    );
    return null;
  }

  const warn = (message: string, detail: string): void => {
    const now = Date.now();
    if (now - (lastWarned.get(message) ?? -Infinity) < WARN_INTERVAL_MS) return;
    lastWarned.set(message, now);
    options.logger.warn({ detail }, message);
  };

  const ready = (async () => {
    const cgroup = parseUserManagerCgroup(
      await readText("/proc/self/cgroup").catch(() => ""),
    );
    const ownUnit = cgroup?.ownPath.split("/").at(-1);
    if (!cgroup || !ownUnit?.endsWith(".service")) {
      warn(
        "Thread cgroups unavailable",
        "daemon is not a systemd user service",
      );
      return null;
    }
    try {
      await busctl(managerCall("GetUnit", "s", ownUnit));
    } catch (error) {
      warn("Thread cgroups unavailable", errorMessage(error));
      return null;
    }
    options.logger.info(
      { ownUnit, slice: THREAD_CGROUP_SLICE },
      "Thread cgroups enabled",
    );
    return {
      procsPath: `/sys/fs/cgroup${cgroup.ownPath}/cgroup.procs`,
      ownUnit,
    };
  })();

  const place = async (
    threadId: string,
    pids: number[],
    ownUnit: string,
  ): Promise<void> => {
    let attachError: unknown;
    try {
      await busctl(attachScopeArgs(threadId, pids));
      return;
    } catch (error) {
      attachError = error;
    }
    try {
      await busctl(startScopeArgs({ threadId, pids, ownUnit }));
    } catch (error) {
      warn(
        "Could not move thread processes into their cgroup",
        `attach: ${errorMessage(attachError)}; start: ${errorMessage(error)}`,
      );
    }
  };

  const identity = async (pid: number): Promise<string | null> => {
    const stat = await readText(`/proc/${pid}/stat`).catch(() => "");
    const startTime = stat
      .slice(stat.lastIndexOf(")") + 2)
      .split(" ")
      .at(STAT_START_TIME_INDEX);
    return startTime ? `${pid}:${startTime}` : null;
  };

  const sweep = async (): Promise<void> => {
    const target = await ready;
    if (!target || stopped) return;
    const procs = await readText(target.procsPath).catch(() => "");
    const nextAttempts = new Map<string, number>();
    const byThread = new Map<string, { pid: number; key: string }[]>();
    for (const pid of procs.split("\n").map(Number)) {
      if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) continue;
      const key = await identity(pid);
      if (key === null) continue;
      const attempts = attemptsLeft.get(key) ?? PLACEMENT_ATTEMPTS;
      nextAttempts.set(key, 0);
      if (attempts === 0) continue;
      const environ = await readText(`/proc/${pid}/environ`).catch(() => null);
      if (environ === null) {
        nextAttempts.set(key, attempts - 1);
        continue;
      }
      const threadId = threadIdFromEnviron(environ);
      if (threadId === null) {
        const recheck = attempts > PLACEMENT_ATTEMPTS - UNTAGGED_RECHECKS;
        nextAttempts.set(key, recheck ? attempts - 1 : 0);
        continue;
      }
      nextAttempts.set(key, attempts - 1);
      byThread.set(threadId, [...(byThread.get(threadId) ?? []), { pid, key }]);
    }
    attemptsLeft = nextAttempts;
    for (const [threadId, candidates] of byThread) {
      if (stopped) return;
      const live = [];
      for (const candidate of candidates) {
        if ((await identity(candidate.pid)) === candidate.key) {
          live.push(candidate);
        }
      }
      if (live.length === 0) continue;
      await place(
        threadId,
        live.map((candidate) => candidate.pid),
        target.ownUnit,
      );
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void sweep()
        .catch((error: unknown) => {
          warn("Thread cgroup sweep failed", errorMessage(error));
        })
        .finally(schedule);
    }, options.intervalMs ?? SWEEP_INTERVAL_MS);
    timer.unref?.();
  };
  void ready.then((target) => {
    if (target) schedule();
  });

  return {
    sweep,
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
