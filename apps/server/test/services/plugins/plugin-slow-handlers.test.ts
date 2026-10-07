import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const SLEEPY_SOURCE = `
export default function plugin(bb: any) {
  bb.cli.register({
    name: "sleepy",
    summary: "Sleeps for argv[0] milliseconds",
    async run(argv: string[]) {
      await new Promise((resolve) => setTimeout(resolve, Number(argv[0])));
      return { exitCode: 0 };
    },
  });
}
`;

async function writeSleepyPlugin(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-sleepy",
      version: "0.1.0",
      bb: {
        name: "Sleepy fixture",
        description: "A CLI command that takes as long as asked.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), SLEEPY_SOURCE);
}

describe("slow plugin handlers", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;
  const warnings: unknown[][] = [];

  beforeEach(async () => {
    warnings.length = 0;
    const logger = {
      debug() {},
      error() {},
      info() {},
      warn(...args: unknown[]) {
        warnings.push(args);
      },
    };
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-slow-handlers-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger: logger as unknown as Logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 5000,
    });
    const rootDir = join(workDir, "sleepy");
    await writeSleepyPlugin(rootDir);
    await service.install(rootDir, { kind: "root" });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  async function runSleepy(durationMs: number): Promise<void> {
    const result = service.runCliCommand("sleepy", [String(durationMs)], {});
    await vi.advanceTimersByTimeAsync(durationMs);
    await expect(result).resolves.toMatchObject({ exitCode: 0 });
  }

  function slowHandlerWarnings(): unknown[][] {
    return warnings.filter((args) => args[1] === "Slow plugin handler");
  }

  it("records the slowest handler and warns once per call over 5 s", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-07T01:31:00Z"),
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());

    await runSleepy(66_500);
    await runSleepy(4_000);

    const stats = service
      .list()
      .find((plugin) => plugin.id === "sleepy")?.handlerStats;
    expect(stats).toMatchObject({
      count: 2,
      maxMs: 66_500,
      maxCall: {
        label: "cli sleepy",
        startedAt: Date.parse("2026-10-07T01:31:00Z"),
      },
    });
    expect(slowHandlerWarnings()).toEqual([
      [
        { pluginId: "sleepy", handler: "cli sleepy", durationMs: 66_500 },
        "Slow plugin handler",
      ],
    ]);
  });

  it("logs one line per handler every 10 s and counts the rest", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-07T01:31:00Z"),
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());

    const burst = Array.from({ length: 100 }, (_, index) =>
      service.runCliCommand("sleepy", [String(5_100 + index)], {}),
    );
    await vi.advanceTimersByTimeAsync(5_199);
    await Promise.all(burst);

    expect(warnings).toEqual([
      [
        { pluginId: "sleepy", handler: "cli sleepy", durationMs: 5_100 },
        "Slow plugin handler",
      ],
    ]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(warnings).toEqual([
      [
        { pluginId: "sleepy", handler: "cli sleepy", durationMs: 5_100 },
        "Slow plugin handler",
      ],
      [
        {
          pluginId: "sleepy",
          handler: "cli sleepy",
          suppressed: 99,
          maxDurationMs: 5_199,
        },
        "Slow plugin handler calls suppressed",
      ],
    ]);
  });

  it("reports no max call before any handler runs", () => {
    const stats = service
      .list()
      .find((plugin) => plugin.id === "sleepy")?.handlerStats;
    expect(stats?.maxCall).toBeUndefined();
  });
});
