import { describe, expect, it } from "vitest";
import {
  parseUserManagerCgroup,
  threadIdFromScopeUnitName,
} from "@bb/config/thread-cgroups";
import {
  aggregateThreadUsage,
  parseScopeFiles,
  type ScopeReading,
} from "./usage.js";

const GIB = 1024 ** 3;

const fullScope = () =>
  new Map([
    [
      "cpu.stat",
      "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\n",
    ],
    ["cpu.max", "800000 100000\n"],
    ["memory.current", `${2 * GIB}\n`],
    ["memory.high", `${16 * GIB}\n`],
    ["pids.current", "7\n"],
  ] as const);

describe("thread scope names", () => {
  it("maps thread and boost scopes to their thread", () => {
    expect(threadIdFromScopeUnitName("bb-thread-thr_ab12.scope")).toBe(
      "thr_ab12",
    );
    expect(threadIdFromScopeUnitName("bb-boost-thr_ab12-4711.scope")).toBe(
      "thr_ab12",
    );
    expect(threadIdFromScopeUnitName("run-r1234.scope")).toBeNull();
    expect(threadIdFromScopeUnitName("bb-thread-thr_a.slice")).toBeNull();
  });

  it("finds the user manager from any cgroup below it", () => {
    expect(
      parseUserManagerCgroup(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-bb.slice/bb-thread-thr_a.scope\n",
      ),
    ).toEqual({
      managerPath: "/user.slice/user-1000.slice/user@1000.service",
      ownPath:
        "/user.slice/user-1000.slice/user@1000.service/app.slice/app-bb.slice/bb-thread-thr_a.scope",
    });
    expect(
      parseUserManagerCgroup(
        "0::/user.slice/user-1000.slice/session-2.scope\n",
      ),
    ).toBeNull();
    expect(parseUserManagerCgroup("")).toBeNull();
  });
});

describe("parseScopeFiles", () => {
  it("reads usage, quota, memory and pids", () => {
    expect(parseScopeFiles("thr_a", fullScope())).toEqual({
      threadId: "thr_a",
      cpuUsageUsec: 5_000_000,
      cpuQuotaCores: 8,
      memoryBytes: 2 * GIB,
      memoryHighBytes: 16 * GIB,
      pids: 7,
    });
  });

  it("reads max limits as unlimited", () => {
    const files = new Map<string, string>(fullScope());
    files.set("cpu.max", "max 100000\n");
    files.set("memory.high", "max\n");
    expect(parseScopeFiles("thr_a", files)).toMatchObject({
      cpuQuotaCores: null,
      memoryHighBytes: null,
    });
  });

  it("reads a scope whose cpu, memory and pids controllers are off", () => {
    expect(
      parseScopeFiles("thr_a", new Map([["cpu.stat", "usage_usec 10\n"]])),
    ).toEqual({
      threadId: "thr_a",
      cpuUsageUsec: 10,
      cpuQuotaCores: null,
      memoryBytes: 0,
      memoryHighBytes: null,
      pids: 0,
    });
  });
});

describe("aggregateThreadUsage", () => {
  const reading = (threadId: string, cpuUsageUsec: number): ScopeReading => ({
    ...parseScopeFiles(threadId, fullScope()),
    cpuUsageUsec,
  });

  it("sums a thread's scopes and sorts by CPU", () => {
    const usage = aggregateThreadUsage({
      before: new Map([
        ["bb-thread-thr_a.scope", reading("thr_a", 0)],
        ["bb-boost-thr_a-1.scope", reading("thr_a", 0)],
        ["bb-thread-thr_b.scope", reading("thr_b", 0)],
      ]),
      after: new Map([
        ["bb-thread-thr_a.scope", reading("thr_a", 1_000_000)],
        ["bb-boost-thr_a-1.scope", reading("thr_a", 2_000_000)],
        ["bb-thread-thr_b.scope", reading("thr_b", 8_000_000)],
      ]),
      elapsedMs: 1_000,
    });
    expect(usage).toEqual([
      {
        threadId: "thr_b",
        cpuCores: 8,
        cpuQuotaCores: 8,
        memoryBytes: 2 * GIB,
        memoryHighBytes: 16 * GIB,
        pids: 7,
      },
      {
        threadId: "thr_a",
        cpuCores: 3,
        cpuQuotaCores: 16,
        memoryBytes: 4 * GIB,
        memoryHighBytes: 32 * GIB,
        pids: 14,
      },
    ]);
  });

  it("counts a scope recreated during the sample from zero", () => {
    const [usage] = aggregateThreadUsage({
      before: new Map([
        ["bb-thread-thr_a.scope", reading("thr_a", 12_000_000)],
      ]),
      after: new Map([["bb-thread-thr_a.scope", reading("thr_a", 100_000)]]),
      elapsedMs: 1_000,
    });
    expect(usage?.cpuCores).toBeCloseTo(0.1);
  });

  it("reports no quota when any of a thread's scopes is unlimited", () => {
    const usage = aggregateThreadUsage({
      before: new Map(),
      after: new Map([
        ["bb-thread-thr_a.scope", reading("thr_a", 0)],
        [
          "bb-boost-thr_a-1.scope",
          { ...reading("thr_a", 0), cpuQuotaCores: null },
        ],
      ]),
      elapsedMs: 1_000,
    });
    expect(usage[0]?.cpuQuotaCores).toBeNull();
  });

  it("counts a scope that appeared during sampling with no CPU", () => {
    const usage = aggregateThreadUsage({
      before: new Map(),
      after: new Map([["bb-thread-thr_a.scope", reading("thr_a", 9_000_000)]]),
      elapsedMs: 1_000,
    });
    expect(usage[0]?.cpuCores).toBe(0);
  });
});
