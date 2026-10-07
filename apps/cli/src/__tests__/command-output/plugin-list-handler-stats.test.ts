import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerPluginCommands } from "../../commands/plugin.js";

function pluginList(handlerStats: object) {
  return {
    plugins: [
      {
        id: "coordinator",
        source: "local",
        rootDir: "/plugins/coordinator",
        version: "1.0.0",
        provenance: "direct",
        publisherLabel: null,
        isOrphanedBuiltin: false,
        sourceDisplay: "local · /plugins/coordinator",
        updateState: {},
        enabled: true,
        description: null,
        name: null,
        icon: null,
        iconUrl: null,
        status: "running",
        statusDetail: null,
        handlerStats,
        services: [],
        schedules: [],
        cliCommand: null,
        hasSettings: false,
        app: { hasApp: false, bundle: null },
        logoUrl: null,
        logoDarkUrl: null,
      },
    ],
  };
}

describe("bb plugin list handler stats", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerPluginCommands(program, () => "http://server");

  function handlersLine(): string | undefined {
    return collectLogPayloads(vi.mocked(console.log)).find((line) =>
      line.startsWith("  handlers:"),
    );
  }

  it("names the call that set the max, with its local start time", async () => {
    const startedAt = new Date();
    startedAt.setHours(1, 31, 0, 0);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        pluginList({
          count: 412,
          totalMs: 98_000,
          maxMs: 66_500,
          maxCall: {
            label: "cli recreate-coordinators",
            startedAt: startedAt.getTime(),
          },
          errorCount: 2,
        }),
      ),
    );

    await runCommand(["plugin", "list"], register);

    expect(handlersLine()).toBe(
      "  handlers: 412 calls / 98.0s total / 66.5s max (cli recreate-coordinators, 01:31), 2 errors",
    );
  });

  it("adds the date when the max is from an earlier day", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        pluginList({
          count: 3,
          totalMs: 9_000,
          maxMs: 7_000,
          maxCall: {
            label: "rpc sync",
            startedAt: new Date(2026, 8, 30, 23, 5).getTime(),
          },
          errorCount: 0,
        }),
      ),
    );

    await runCommand(["plugin", "list"], register);

    expect(handlersLine()).toBe(
      "  handlers: 3 calls / 9.0s total / 7.0s max (rpc sync, 2026-09-30 23:05)",
    );
  });

  it("keeps the old line when the server reports no max call", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        pluginList({ count: 2, totalMs: 30, maxMs: 20, errorCount: 0 }),
      ),
    );

    await runCommand(["plugin", "list"], register);

    expect(handlersLine()).toBe("  handlers: 2 calls / 30ms total / 20ms max");
  });
});
