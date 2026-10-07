import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlowHandlerLog } from "../../../src/services/plugins/slow-handler-log.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createSlowHandlerLog()", () => {
  it("never throws from record or the timer flush when the logger does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let loggerDown = true;
    const warnings: unknown[][] = [];
    const log = createSlowHandlerLog({
      warn: (...args: unknown[]) => {
        if (loggerDown) throw new Error("logger down");
        warnings.push(args);
      },
    });

    expect(() => log.record("sleepy", "cli sleepy", 6_000)).not.toThrow();
    expect(() => log.record("sleepy", "cli sleepy", 7_000)).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);

    loggerDown = false;
    await vi.advanceTimersByTimeAsync(10_000);
    log.record("sleepy", "cli sleepy", 8_000);

    expect(warnings).toEqual([
      [
        { pluginId: "sleepy", handler: "cli sleepy", durationMs: 8_000 },
        "Slow plugin handler",
      ],
    ]);
  });
});
