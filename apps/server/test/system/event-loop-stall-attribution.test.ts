import { createConnection } from "@bb/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordEventLoopDbQuery,
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

  it("receives every statement from a connection created with onQuery", () => {
    const onQuery = vi.fn();
    const db = createConnection(":memory:", {
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
      const sampler = startEventLoopStallSampler({ logger });
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
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
      } finally {
        sampler.stop();
      }
    },
  );
});
