import {
  createFakePluginHost,
  makeQueueEntry,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  tipListEntrySchema,
  tipViewSchema,
  type TipClient,
} from "./contract.js";
import plugin from "./server.js";

const WEB_MAC: TipClient = { surface: "web", os: "macos" };

const currentResultSchema = z.object({ tip: tipViewSchema.nullable() });
const listResultSchema = z.object({
  enabled: z.boolean(),
  tips: z.array(tipListEntrySchema),
});

interface Fixture {
  version?: string;
  threadCount?: number;
  finishedThreadCount?: number;
  providersUsed?: string[];
  plugins?: Record<string, boolean>;
  settings?: Record<string, boolean>;
}

async function setup(fixture: Fixture = {}) {
  const fake = createFakePluginHost({
    pluginId: "bb--tips",
    ...(fixture.settings === undefined ? {} : { settings: fixture.settings }),
    sdk: {
      system: {
        version: async () => ({ currentVersion: fixture.version ?? "1.0.0" }),
      },
      threads: {
        count: async (args) => {
          if (args?.groupBy === "provider") {
            return {
              total: fixture.threadCount ?? 0,
              groups: (fixture.providersUsed ?? []).map((key) => ({
                key,
                count: 1,
              })),
            };
          }
          return {
            total:
              args?.status === "idle"
                ? (fixture.finishedThreadCount ?? 0)
                : (fixture.threadCount ?? 0),
          };
        },
        list: async () => [],
        get: async () => makeThreadResponse({ providerId: "claude-code" }),
      },
      providers: { catalog: async () => [] },
      plugins: {
        list: async () => ({
          plugins: Object.entries(fixture.plugins ?? {}).map(
            ([id, enabled]) => ({ id, enabled }),
          ),
        }),
      },
    },
  });
  await plugin(fake.bb);
  const { harness } = fake;
  return {
    ...fake,
    async current(client: TipClient = WEB_MAC) {
      return currentResultSchema.parse(
        await harness.behavior.callRpc("current", { client }),
      ).tip;
    },
    async listAll() {
      return listResultSchema.parse(
        await harness.behavior.callRpc("list", { client: WEB_MAC, all: true }),
      );
    },
  };
}

const NEW_USER = { threadCount: 1, finishedThreadCount: 1 };

describe("tips plugin registration", () => {
  it("declares an on-by-default switch and the bb tips command", async () => {
    const { harness } = await setup();
    expect(harness.registrations.settingsDescriptors.enabled).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(harness.registrations.cli?.name).toBe("tips");
    expect(
      harness.registrations.cli?.commands.map((command) => command.name),
    ).toEqual(expect.arrayContaining(["list", "dismiss", "reset"]));
    expect(harness.registrations.rpcMethods).toEqual(
      expect.arrayContaining(["current", "dismiss", "act", "list", "reset"]),
    );
  });
});

describe("current tip", () => {
  it("shows nothing before the first finished thread", async () => {
    const host = await setup();
    expect(await host.current()).toBeNull();
  });

  it("shows subthreads after the first finished thread and keeps it for the day", async () => {
    const host = await setup(NEW_USER);
    const first = await host.current();
    expect(first?.id).toBe("subthreads");
    expect(first?.action?.kind).toBe("prompt");
    expect((await host.current())?.id).toBe("subthreads");
    const list = await host.listAll();
    expect(list.tips.find((entry) => entry.id === "subthreads")).toMatchObject({
      status: "current",
      shownDays: 1,
    });
  });

  it("puts Account Pooler first after a Codex rate limit", async () => {
    const host = await setup({
      ...NEW_USER,
      providersUsed: ["codex"],
      plugins: { "account-pool": false },
    });
    await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        errorInfo: {
          category: "rate-limit",
          providerCode: null,
          httpStatusCode: 429,
        },
      }),
    );
    expect((await host.current())?.id).toBe("account-pool");
  });

  it("ignores rate limits from providers the pool cannot serve", async () => {
    const host = await setup({
      ...NEW_USER,
      providersUsed: ["codex"],
      plugins: { "account-pool": false },
    });
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ providerId: "pi" }),
    );
    await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        errorInfo: {
          category: "rate-limit",
          providerCode: null,
          httpStatusCode: 429,
        },
      }),
    );
    expect((await host.current())?.id).toBe("subthreads");
  });

  it("retires subthreads once a child thread is created", async () => {
    const host = await setup(NEW_USER);
    await host.harness.behavior.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({ parentThreadId: "thread-parent" }),
    });
    expect((await host.current())?.id).toBe("set-up-for-me");
    const list = await host.listAll();
    expect(list.tips.find((entry) => entry.id === "subthreads")).toMatchObject({
      status: "retired",
      retiredReason: "used",
    });
  });

  it("retires queue-or-steer once a follow-up is queued behind a running turn", async () => {
    const host = await setup({ threadCount: 3, finishedThreadCount: 3 });
    await host.harness.behavior.emitThreadEvent("message.queued", {
      entry: makeQueueEntry({ waitingOn: null }),
    });
    const list = await host.listAll();
    expect(
      list.tips.find((entry) => entry.id === "queue-or-steer"),
    ).toMatchObject({ status: "retired", retiredReason: "used" });
  });

  it("does not count a plugin-held or scheduled row as a queued follow-up", async () => {
    const host = await setup({ threadCount: 3, finishedThreadCount: 3 });
    await host.harness.behavior.emitThreadEvent("message.queued", {
      entry: makeQueueEntry(),
    });
    await host.harness.behavior.emitThreadEvent("message.queued", {
      entry: makeQueueEntry({ waitingOn: null, sendAt: 1 }),
    });
    const list = await host.listAll();
    expect(
      list.tips.find((entry) => entry.id === "queue-or-steer")?.status,
    ).not.toBe("retired");
  });

  it("stays hidden and records nothing while tips are turned off", async () => {
    const host = await setup({ ...NEW_USER, settings: { enabled: false } });
    expect(await host.current()).toBeNull();
    expect(await host.bb.storage.kv.get("state")).toBeUndefined();
  });
});

describe("dismissing and acting", () => {
  it("dismisses a tip for good and shows no other tip until tomorrow", async () => {
    const host = await setup(NEW_USER);
    expect((await host.current())?.id).toBe("subthreads");
    await host.harness.behavior.callRpc("dismiss", { id: "subthreads" });
    expect(await host.current()).toBeNull();
    expect(host.harness.realtimeSignals).toContainEqual({
      channel: "tips-changed",
      payload: {},
    });
    const list = await host.listAll();
    expect(list.tips.find((entry) => entry.id === "subthreads")).toMatchObject({
      status: "dismissed",
      dismissed: true,
    });
  });

  it("retires a tip once its action is taken", async () => {
    const host = await setup(NEW_USER);
    await host.current();
    await host.harness.behavior.callRpc("act", { id: "subthreads" });
    const list = await host.listAll();
    expect(list.tips.find((entry) => entry.id === "subthreads")).toMatchObject({
      status: "retired",
      acted: true,
      retiredReason: "acted",
    });
  });

  it("rejects an unknown tip id over RPC", async () => {
    const host = await setup(NEW_USER);
    await expect(
      host.harness.behavior.callRpc("dismiss", { id: "nope" }),
    ).rejects.toThrow("Unknown tip: nope");
  });
});

describe("bb tips", () => {
  it("lists eligible tips and marks the one showing today", async () => {
    const host = await setup(NEW_USER);
    await host.current();
    const result = await host.harness.behavior.runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("subthreads (showing today)");
    expect(result.stdout).toContain("set-up-for-me");
    expect(result.stdout).not.toContain("account-pool");
  });

  it("prints JSON with every tip and its status when asked", async () => {
    const host = await setup(NEW_USER);
    const result = await host.harness.behavior.runCli(["--all", "--json"]);
    expect(result.exitCode).toBe(0);
    const view = listResultSchema.parse(JSON.parse(result.stdout));
    expect(view.enabled).toBe(true);
    expect(view.tips.find((entry) => entry.id === "account-pool")?.status).toBe(
      "not-applicable",
    );
    expect(view.tips.find((entry) => entry.id === "subthreads")?.status).toBe(
      "eligible",
    );
  });

  it("dismisses a tip by id and refuses unknown ids", async () => {
    const host = await setup(NEW_USER);
    const dismissed = await host.harness.behavior.runCli([
      "dismiss",
      "subthreads",
    ]);
    expect(dismissed).toMatchObject({
      exitCode: 0,
      stdout: "Dismissed subthreads.",
    });
    expect((await host.harness.behavior.runCli(["list"])).stdout).not.toContain(
      "subthreads",
    );
    const unknown = await host.harness.behavior.runCli(["dismiss", "nope"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown tip: nope");
  });

  it("resets dismissed tips so they can show again", async () => {
    const host = await setup(NEW_USER);
    await host.current();
    await host.harness.behavior.runCli(["dismiss", "subthreads"]);
    expect(await host.current()).toBeNull();
    const reset = await host.harness.behavior.runCli(["reset"]);
    expect(reset).toMatchObject({ exitCode: 0, stdout: "Tips reset." });
    expect((await host.current())?.id).toBe("subthreads");
  });

  it("says when tips are turned off", async () => {
    const host = await setup({ ...NEW_USER, settings: { enabled: false } });
    const result = await host.harness.behavior.runCli([]);
    expect(result.stdout).toContain("Tips are turned off.");
  });
});
