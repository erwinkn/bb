import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startThreadCgroups,
  threadIdFromEnviron,
  type ThreadCgroups,
} from "./thread-cgroups.js";

const SERVICE_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/bb-app.service\n";
const PROCS_PATH =
  "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/bb-app.service/cgroup.procs";

const environ = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\0");

interface Harness {
  files: Map<string, string>;
  calls: string[][];
  failing: Set<string>;
  onBusctl: (args: string[]) => void;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  cgroups: ThreadCgroups | null;
}

const started: ThreadCgroups[] = [];

afterEach(() => {
  for (const cgroups of started.splice(0)) cgroups.stop();
});

function createHarness(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    selfCgroup?: string;
  } = {},
): Harness {
  const files = new Map<string, string>([
    ["/proc/self/cgroup", options.selfCgroup ?? SERVICE_CGROUP],
  ]);
  const calls: string[][] = [];
  const failing = new Set<string>();
  const harness: Pick<Harness, "onBusctl"> = { onBusctl: () => {} };
  const info = vi.fn();
  const warn = vi.fn();
  const cgroups = startThreadCgroups({
    logger: { info, warn },
    env: options.env ?? {},
    platform: options.platform ?? "linux",
    selfPid: 1,
    intervalMs: 3_600_000,
    readText: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    busctl: async (args) => {
      calls.push(args);
      harness.onBusctl(args);
      const method = args[5] ?? "";
      if (failing.has(method)) {
        throw Object.assign(new Error("busctl failed"), {
          stderr: `${method} refused`,
        });
      }
    },
  });
  if (cgroups) started.push(cgroups);
  return Object.assign(harness, { files, calls, failing, info, warn, cgroups });
}

const stat = (pid: string, startTime: string) =>
  `${pid} (my) prog) S ${Array(18).fill("0").join(" ")} ${startTime} 0`;

function setProcesses(
  harness: Harness,
  processes: Record<number, Record<string, string>>,
  startTime = "100",
) {
  harness.files.set(PROCS_PATH, `${Object.keys(processes).join("\n")}\n`);
  for (const [pid, vars] of Object.entries(processes)) {
    harness.files.set(`/proc/${pid}/stat`, stat(pid, startTime));
    harness.files.set(`/proc/${pid}/environ`, environ(vars));
  }
}

const placementCalls = (harness: Harness) =>
  harness.calls.filter((args) => args[5] !== "GetUnit");

describe("threadIdFromEnviron", () => {
  it("reads a unit-safe BB_THREAD_ID", () => {
    expect(
      threadIdFromEnviron(environ({ PATH: "/bin", BB_THREAD_ID: "thr_ab12" })),
    ).toBe("thr_ab12");
  });

  it("rejects missing or unit-unsafe thread ids", () => {
    expect(threadIdFromEnviron(environ({ PATH: "/bin" }))).toBeNull();
    expect(
      threadIdFromEnviron(environ({ BB_THREAD_ID: "thr_x.scope/../y" })),
    ).toBeNull();
  });
});

describe("startThreadCgroups", () => {
  it("is a no-op off Linux, when disabled, and inside a thread", () => {
    expect(createHarness({ platform: "darwin" }).cgroups).toBeNull();
    expect(
      createHarness({ env: { BB_THREAD_CGROUPS: "0" } }).cgroups,
    ).toBeNull();
    expect(
      createHarness({ env: { BB_THREAD_ID: "thr_a" } }).cgroups,
    ).toBeNull();
  });

  it("stays idle when the daemon is not a systemd user service", async () => {
    const harness = createHarness({
      selfCgroup: "0::/user.slice/user-1000.slice/session-2.scope\n",
    });
    setProcesses(harness, { 10: { BB_THREAD_ID: "thr_a" } });
    await harness.cgroups?.sweep();
    expect(harness.calls).toEqual([]);
    expect(harness.warn).toHaveBeenCalledTimes(1);
  });

  it("stays idle when the user manager does not answer", async () => {
    const harness = createHarness();
    harness.failing.add("GetUnit");
    setProcesses(harness, { 10: { BB_THREAD_ID: "thr_a" } });
    await harness.cgroups?.sweep();
    expect(placementCalls(harness)).toEqual([]);
    expect(harness.warn).toHaveBeenCalledWith(
      { detail: "GetUnit refused" },
      "Thread cgroups unavailable",
    );
  });

  it("moves each thread's processes into its scope in one call", async () => {
    const harness = createHarness();
    setProcesses(harness, {
      1: { BB_THREAD_ID: "thr_self" },
      10: { BB_THREAD_ID: "thr_a" },
      11: { PATH: "/bin" },
      12: { BB_THREAD_ID: "thr_a" },
      13: { BB_THREAD_ID: "thr_b" },
    });
    await harness.cgroups?.sweep();
    expect(placementCalls(harness).map((args) => args.slice(5))).toEqual([
      [
        "AttachProcessesToUnit",
        "ssau",
        "bb-thread-thr_a.scope",
        "/",
        "2",
        "10",
        "12",
      ],
      [
        "AttachProcessesToUnit",
        "ssau",
        "bb-thread-thr_b.scope",
        "/",
        "1",
        "13",
      ],
    ]);
  });

  it("creates the scope with limits and stop propagation when attach fails", async () => {
    const harness = createHarness();
    harness.failing.add("AttachProcessesToUnit");
    setProcesses(harness, { 10: { BB_THREAD_ID: "thr_a" } });
    await harness.cgroups?.sweep();
    const create = placementCalls(harness).find(
      (args) => args[5] === "StartTransientUnit",
    );
    expect(create?.slice(5, 13)).toEqual([
      "StartTransientUnit",
      "ssa(sv)a(sa(sv))",
      "bb-thread-thr_a.scope",
      "fail",
      "11",
      "PIDs",
      "au",
      "1",
    ]);
    expect(create?.join(" ")).toContain("Slice s app-bb.slice");
    expect(create?.join(" ")).toContain("Delegate b true");
    expect(create?.join(" ")).toContain("OOMPolicy s continue");
    expect(create?.join(" ")).toContain("CPUQuotaPerSecUSec t 8000000");
    expect(create?.join(" ")).toContain("MemoryHigh t 17179869184");
    expect(create?.join(" ")).toContain(
      "StopPropagatedFrom as 1 bb-app.service",
    );
    expect(create?.join(" ")).toContain("Before as 1 bb-app.service");
    expect(create?.at(-1)).toBe("0");
  });

  it("places a process caught between fork and exec once it has its thread id", async () => {
    const harness = createHarness();
    setProcesses(harness, { 11: { PATH: "/bin" } });
    await harness.cgroups?.sweep();
    harness.files.set("/proc/11/environ", environ({ BB_THREAD_ID: "thr_a" }));
    await harness.cgroups?.sweep();
    expect(placementCalls(harness)).toHaveLength(1);
  });

  it("stops checking unrelated processes after a few sweeps and placed ones at once", async () => {
    const harness = createHarness();
    setProcesses(harness, {
      10: { BB_THREAD_ID: "thr_a" },
      11: { PATH: "/bin" },
    });
    await harness.cgroups?.sweep();
    harness.files.set(PROCS_PATH, "11\n");
    for (let sweep = 0; sweep < 3; sweep += 1) {
      await harness.cgroups?.sweep();
    }
    harness.files.set("/proc/11/environ", environ({ BB_THREAD_ID: "thr_a" }));
    await harness.cgroups?.sweep();
    expect(placementCalls(harness)).toHaveLength(1);
  });

  it("retries a process that an acknowledged placement left in place", async () => {
    const harness = createHarness();
    harness.failing.add("AttachProcessesToUnit");
    setProcesses(harness, { 10: { BB_THREAD_ID: "thr_a" } });
    await harness.cgroups?.sweep();
    await harness.cgroups?.sweep();
    expect(
      placementCalls(harness).filter(
        (args) => args[5] === "StartTransientUnit",
      ),
    ).toHaveLength(2);
  });

  it("retries a failed placement a bounded number of times and logs once", async () => {
    const harness = createHarness();
    harness.failing.add("AttachProcessesToUnit");
    harness.failing.add("StartTransientUnit");
    setProcesses(harness, { 10: { BB_THREAD_ID: "thr_a" } });
    for (let sweep = 0; sweep < 40; sweep += 1) {
      await harness.cgroups?.sweep();
    }
    expect(placementCalls(harness)).toHaveLength(60);
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledWith(
      {
        detail:
          "attach: AttachProcessesToUnit refused; start: StartTransientUnit refused",
      },
      "Could not move thread processes into their cgroup",
    );
  });

  it("logs a failure again once a minute has passed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const harness = createHarness();
    harness.failing.add("AttachProcessesToUnit");
    harness.failing.add("StartTransientUnit");
    setProcesses(harness, { 10: { BB_THREAD_ID: "thr_a" } });
    await harness.cgroups?.sweep();
    now.mockReturnValue(1_030_000);
    await harness.cgroups?.sweep();
    now.mockReturnValue(1_060_000);
    await harness.cgroups?.sweep();
    now.mockRestore();
    expect(harness.warn).toHaveBeenCalledTimes(2);
  });

  it("forgets processes that left so a reused pid is checked again", async () => {
    const harness = createHarness();
    setProcesses(harness, { 11: { PATH: "/bin" } });
    await harness.cgroups?.sweep();
    setProcesses(harness, {});
    await harness.cgroups?.sweep();
    setProcesses(harness, { 11: { BB_THREAD_ID: "thr_a" } });
    await harness.cgroups?.sweep();
    expect(placementCalls(harness)).toHaveLength(1);
  });

  it("checks a reused pid again when its start time changed", async () => {
    const harness = createHarness();
    setProcesses(harness, { 11: { PATH: "/bin" } });
    await harness.cgroups?.sweep();
    setProcesses(harness, { 11: { BB_THREAD_ID: "thr_a" } }, "200");
    await harness.cgroups?.sweep();
    expect(placementCalls(harness)).toHaveLength(1);
  });

  it("skips a pid reused while an earlier placement was in flight", async () => {
    const harness = createHarness();
    setProcesses(harness, {
      10: { BB_THREAD_ID: "thr_a" },
      12: { BB_THREAD_ID: "thr_b" },
    });
    harness.onBusctl = (args) => {
      if (args[5] === "AttachProcessesToUnit") {
        harness.files.set("/proc/12/stat", stat("12", "300"));
      }
    };
    await harness.cgroups?.sweep();
    expect(placementCalls(harness).map((args) => args[7])).toEqual([
      "bb-thread-thr_a.scope",
    ]);
  });

  it("retries a process whose environment could not be read", async () => {
    const harness = createHarness();
    setProcesses(harness, { 10: { BB_THREAD_ID: "thr_a" } });
    const readable = harness.files.get("/proc/10/environ") ?? "";
    harness.files.delete("/proc/10/environ");
    await harness.cgroups?.sweep();
    harness.files.set("/proc/10/environ", readable);
    await harness.cgroups?.sweep();
    expect(placementCalls(harness)).toHaveLength(1);
  });
});
