import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpRequestLog,
  type FinishedHttpRequest,
} from "../src/request-log.js";

const slowRequest: FinishedHttpRequest = {
  method: "GET",
  path: "/api/v1/hosts",
  status: 200,
  originTtfbMs: 6_000,
  totalMs: 6_000,
  relayCloseReason: null,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createHttpRequestLog()", () => {
  it("summarizes suppressed requests at the end of the 10 s window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const warnings: string[] = [];
    const log = createHttpRequestLog({ warn: (line) => warnings.push(line) });

    log.record(slowRequest);
    await vi.advanceTimersByTimeAsync(1_000);
    log.record({ ...slowRequest, totalMs: 7_000 });
    log.record({ ...slowRequest, totalMs: 8_000 });
    log.record({ ...slowRequest, path: "/api/v1/projects" });

    expect(warnings).toEqual([
      "bb connect slow request method=GET path=/api/v1/hosts status=200 originTtfbMs=6000 totalMs=6000",
      "bb connect slow request method=GET path=/api/v1/projects status=200 originTtfbMs=6000 totalMs=6000",
    ]);

    await vi.advanceTimersByTimeAsync(9_000);

    expect(warnings.slice(2)).toEqual([
      "bb connect slow request method=GET path=/api/v1/hosts suppressed=2 maxTotalMs=8000",
    ]);

    await vi.advanceTimersByTimeAsync(10_000);
    log.record(slowRequest);

    expect(warnings.slice(3)).toEqual([
      "bb connect slow request method=GET path=/api/v1/hosts status=200 originTtfbMs=6000 totalMs=6000",
    ]);
  });

  it("never throws from record, the timer flush or dispose when the logger does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let loggerDown = true;
    const warnings: string[] = [];
    const log = createHttpRequestLog({
      warn: (line) => {
        if (loggerDown) throw new Error("logger down");
        warnings.push(line);
      },
    });

    expect(() => log.record(slowRequest)).not.toThrow();
    expect(() => log.record(slowRequest)).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(() => log.record(slowRequest)).not.toThrow();
    expect(() => log.dispose()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);

    loggerDown = false;
    await vi.advanceTimersByTimeAsync(10_000);
    log.record(slowRequest);
    log.dispose();

    expect(warnings).toEqual([
      "bb connect slow request method=GET path=/api/v1/hosts status=200 originTtfbMs=6000 totalMs=6000",
    ]);
  });
});
