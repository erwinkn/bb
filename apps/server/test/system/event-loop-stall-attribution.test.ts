import { ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMigratedConnection } from "@bb/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordEventLoopDbQuery,
  startSpawnAttribution,
  summarizeSpawnsBetween,
  takeEventLoopAttributionWindow,
} from "../../src/services/system/event-loop-stall-attribution.js";
import { startEventLoopStallSampler } from "../../src/services/system/event-loop-stall-sampler.js";
import {
  resetEventLoopWorkForTests,
  runEventLoopWorkSync,
} from "../../src/services/system/event-loop-work.js";

afterEach(() => {
  resetEventLoopWorkForTests();
  takeEventLoopAttributionWindow();
});

function burnTheEventLoop(durationMs: number): number {
  const end = Date.now() + durationMs;
  let value = 0;
  while (Date.now() < end) value += Math.sqrt(value + 1);
  return value;
}

describe("event loop stall attribution", () => {
  it("adds up database time per work label and starts a fresh window", () => {
    runEventLoopWorkSync("plugin:sidebar rpc", () => {
      recordEventLoopDbQuery({ durationMs: 30, source: "select 1" });
      recordEventLoopDbQuery({
        durationMs: 40,
        source: "select *\n  from events where id = 'evt_secret'",
      });
    });
    recordEventLoopDbQuery({ durationMs: 5, source: "select 2" });

    expect(takeEventLoopAttributionWindow()).toMatchObject({
      dbMs: 75,
      dbQueries: 3,
      dbTopWork: "plugin:sidebar rpc 70ms | (unlabelled) 5ms",
      slowestQuery: "select * from events where id = '?'",
      slowestQueryMs: 40,
    });
    expect(takeEventLoopAttributionWindow()).toMatchObject({
      dbMs: 0,
      dbQueries: 0,
      dbTopWork: null,
      slowestQuery: null,
    });
  });

  it("times each process spawn on the event loop", async () => {
    const originalSpawn = ChildProcess.prototype["spawn" as keyof ChildProcess];
    const stop = startSpawnAttribution();
    const startedAt = Date.now();
    try {
      takeEventLoopAttributionWindow();
      await promisify(execFile)(process.execPath, ["-e", "0"]);
      burnTheEventLoop(30);
      const window = takeEventLoopAttributionWindow();
      expect(window).toMatchObject({
        slowestSpawn: expect.stringMatching(/^node/u),
        spawnCount: 1,
      });
      expect(window.spawnMs).toBeGreaterThan(0);
      expect(window.spawnMaxMs).toBe(window.spawnMs);
      expect(window.mainThreadCpuMs).toBeGreaterThanOrEqual(20);
      expect(window.windowMs).toBeGreaterThanOrEqual(window.mainThreadCpuMs);
      expect(summarizeSpawnsBetween(startedAt, Date.now())).toEqual({
        spawnCount: 1,
        spawnMs: window.spawnMs,
      });
      expect(summarizeSpawnsBetween(0, startedAt - 1)).toEqual({
        spawnCount: 0,
        spawnMs: 0,
      });
    } finally {
      stop();
    }
    expect(ChildProcess.prototype["spawn" as keyof ChildProcess]).toBe(
      originalSpawn,
    );
  });

  it("receives every statement from a connection created with onQuery", () => {
    const onQuery = vi.fn();
    const db = createMigratedConnection({
      onQuery,
      slowQueryLogger: { info: vi.fn() },
    });
    db.$client.prepare("select 1").get();
    db.$client.close();

    expect(onQuery).toHaveBeenCalledWith(
      expect.objectContaining({ source: "select 1" }),
    );
  });

  it(
    "samples the main thread's stack while it is stalled",
    { timeout: 15_000 },
    async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const onSample = vi.fn();
      const sampler = startEventLoopStallSampler({ logger, onSample });
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const startedAt = Date.now();
        burnTheEventLoop(1_200);
        await vi.waitFor(
          () => {
            expect(logger.info).toHaveBeenCalledWith(
              expect.objectContaining({
                topFunctions: expect.arrayContaining([
                  expect.stringContaining(
                    "event-loop-stall-attribution.test.ts",
                  ),
                ]),
              }),
              "Event loop stall sampled",
            );
          },
          { timeout: 5_000, interval: 50 },
        );
        expect(logger.warn).not.toHaveBeenCalled();
        expect(onSample).toHaveBeenCalledTimes(1);
        const [sample] = onSample.mock.calls[0]!;
        expect(sample).toMatchObject({ spawnCount: 0, spawnMs: 0 });
        expect(sample.peakLagMs).toBeGreaterThanOrEqual(250);
        expect(Math.abs(sample.startedAt - startedAt)).toBeLessThan(150);
        if (process.platform === "linux") {
          expect(sample.mainThread.wallMs).toBeGreaterThanOrEqual(1_150);
          expect(
            sample.mainThread.cpuMs + sample.mainThread.runQueueMs,
          ).toBeGreaterThanOrEqual(900);
          expect(sample.mainThread.offCpuMs).toBeGreaterThanOrEqual(0);
          expect(sample.mainThread.majorFaults).toBeGreaterThanOrEqual(0);
        } else {
          expect(sample.mainThread).toBeNull();
        }
      } finally {
        sampler.stop();
      }
    },
  );
});
