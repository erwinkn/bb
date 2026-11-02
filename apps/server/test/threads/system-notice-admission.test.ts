import {
  createQueuedThreadMessage,
  getLatestThreadSequence,
  getQueuedThreadMessage,
  listEvents,
  listQueuedThreadMessages,
  queuedThreadMessages,
  threads,
} from "@bb/db";
import {
  turnRequestEventDataSchema,
  turnScope,
  type SystemMessageSubject,
} from "@bb/domain";
import { eq } from "drizzle-orm";
import type {
  MessageDispatchHookContext,
  PluginHookName,
} from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import {
  requestQueuedMessageDispatch,
  runQueuedMessageDispatch,
} from "../../src/services/threads/queued-message-dispatch.js";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/system-notice-admission-project";

const afterContinue = vi.hoisted(() => ({
  run: null as (() => void) | null,
}));

vi.mock("../../src/services/threads/dispatch-hooks.js", async (actual) => {
  const real =
    await actual<
      typeof import("../../src/services/threads/dispatch-hooks.js")
    >();
  return {
    ...real,
    runMessageDispatchHookPass: (
      ...[deps, request]: Parameters<typeof real.runMessageDispatchHookPass>
    ) =>
      real.runMessageDispatchHookPass(deps, {
        ...request,
        continueAfterHooks: async () => {
          await request.continueAfterHooks?.();
          const run = afterContinue.run;
          afterContinue.run = null;
          run?.();
        },
      }),
  };
});

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

type Decision = "proceed" | "wait" | "reject" | "throw";

interface SeenPass {
  attempt: MessageDispatchHookContext["attempt"];
  initiator: MessageDispatchHookContext["initiator"];
  senderThreadId: MessageDispatchHookContext["senderThreadId"];
  queuedIds: string[];
  text: string;
}

function installGate(initial: Decision) {
  const gate = {
    decision: initial,
    seen: [] as SeenPass[],
    duringPass: null as (() => void) | null,
  };
  const registry: HookRegistry = {
    "message.dispatch": [
      {
        pluginId: "memory",
        handler: (context) => {
          gate.seen.push({
            attempt: context.attempt,
            initiator: context.initiator,
            senderThreadId: context.senderThreadId,
            queuedIds: context.queuedMessages.map((message) => message.id),
            text: context.input.text,
          });
          const duringPass = gate.duringPass;
          gate.duringPass = null;
          duringPass?.();
          if (gate.decision === "throw") {
            throw new Error("memory store offline");
          }
          if (gate.decision === "wait") {
            return { action: "wait", reason: "preparing summaries" } as const;
          }
          if (gate.decision === "reject") {
            return { action: "reject", message: "memory unavailable" } as const;
          }
          return { action: "proceed" } as const;
        },
      },
    ],
  };
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
  return gate;
}

afterEach(() => {
  afterContinue.run = null;
  setPluginHookProvider(undefined);
  vi.useRealTimers();
});

function seedParent(
  harness: TestAppHarness,
  args: { hostId: string; status: "idle" | "active" | "stopping" },
) {
  const { host } = seedHostSession(harness.deps, { id: args.hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: args.status,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${args.hostId}`,
    threadId: thread.id,
  });
  if (args.status !== "idle") {
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      threadId: thread.id,
      turnId: `turn-${args.hostId}`,
      providerThreadId: `provider-${args.hostId}`,
    });
  }
  return { environment, project, thread };
}

const SUBJECT: SystemMessageSubject = {
  kind: "thread",
  threadId: "thr_child",
  threadName: "Review r1",
  outcomes: [{ threadId: "thr_child", status: "completed" }],
};

const NOTICE_TEXT = "[bb system]\n\n@thread:thr_child completed:\n\nverdict";

function systemTurnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)))
    .filter((data) => data.initiator === "system");
}

function turnSubmits(harness: TestAppHarness, threadId: string) {
  return listQueuedThreadCommands(harness, "turn.submit", threadId);
}

function queueChildCompleted(harness: TestAppHarness, threadId: string) {
  return queueParentSystemMessage(harness.deps, {
    input: textInput(NOTICE_TEXT),
    parentThreadId: threadId,
    systemMessageKind: "child-completed",
    systemMessageSubject: SUBJECT,
  });
}

function onlyRow(harness: TestAppHarness, threadId: string) {
  const rows = listQueuedThreadMessages(harness.db, threadId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function expectHeldNotice(harness: TestAppHarness, threadId: string) {
  const row = onlyRow(harness, threadId);
  expect(row.claimToken).toBeNull();
  expect(JSON.parse(row.systemNotice!)).toEqual({
    kind: "child-completed",
    subject: SUBJECT,
  });
  const entry = toThreadQueuedMessage(row);
  expect(entry.content).toEqual(textInput(NOTICE_TEXT));
  expect(entry.initiator).toBe("system");
  expect(entry.waitingOn).toEqual({
    kind: "plugin",
    pluginId: "memory",
    reason: "preparing summaries",
  });
  return row;
}

function expectDeliveredOnce(harness: TestAppHarness, threadId: string) {
  const requests = systemTurnRequests(harness, threadId);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    initiator: "system",
    senderThreadId: null,
    systemMessageKind: "child-completed",
    systemMessageSubject: SUBJECT,
    input: textInput(NOTICE_TEXT),
  });
  expect(turnSubmits(harness, threadId)).toHaveLength(1);
  expect(listQueuedThreadMessages(harness.db, threadId)).toEqual([]);
}

function endTurnDuringPass(
  harness: TestAppHarness,
  args: { environmentId: string; hostId: string; threadId: string },
) {
  seedStoredEvent(harness.deps, {
    data: { status: "completed" },
    environmentId: args.environmentId,
    providerThreadId: `provider-${args.hostId}`,
    scope: turnScope(`turn-${args.hostId}`),
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    threadId: args.threadId,
    type: "turn/completed",
  });
  harness.db
    .update(threads)
    .set({ status: "idle" })
    .where(eq(threads.id, args.threadId))
    .run();
}

function setStatus(
  harness: TestAppHarness,
  threadId: string,
  status: "idle" | "starting" | "stopping",
) {
  harness.db
    .update(threads)
    .set({ status })
    .where(eq(threads.id, threadId))
    .run();
}

function markStarting(harness: TestAppHarness, threadId: string) {
  setStatus(harness, threadId, "starting");
}

function stopRightAfterSettling(harness: TestAppHarness, threadId: string) {
  afterContinue.run = () => {
    requestQueuedMessageDispatch(harness.deps, {
      kind: "provisioning-ended",
      threadId,
    });
    harness.db
      .update(threads)
      .set({ status: "idle" })
      .where(eq(threads.id, threadId))
      .run();
  };
}

function seedHeldNotice(harness: TestAppHarness, threadId: string) {
  return createQueuedThreadMessage(harness.db, harness.hub, {
    threadId,
    content: textInput(NOTICE_TEXT),
    senderThreadId: null,
    origin: null,
    originPluginId: null,
    model: "fake-model",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: {
      kind: "plugin",
      pluginId: "memory",
      reason: "preparing summaries",
    },
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: { kind: "child-completed", subject: SUBJECT },
  });
}

describe("parent system notices at the dispatch checkpoint", () => {
  it("holds an idle parent's notice on a plugin wait and delivers it once on recheck", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("wait");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-direct",
        status: "idle",
      });

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);

      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(turnSubmits(harness, thread.id)).toEqual([]);
      const held = expectHeldNotice(harness, thread.id);

      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expectHeldNotice(harness, thread.id);

      gate.decision = "proceed";
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2_000 });
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expectDeliveredOnce(harness, thread.id);

      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      await sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: thread.id,
      });
      expectDeliveredOnce(harness, thread.id);

      expect(gate.seen).toEqual([
        {
          attempt: "start-turn",
          initiator: "system",
          senderThreadId: null,
          queuedIds: [],
          text: NOTICE_TEXT,
        },
        {
          attempt: "start-turn",
          initiator: "system",
          senderThreadId: null,
          queuedIds: [held.id],
          text: NOTICE_TEXT,
        },
        {
          attempt: "start-turn",
          initiator: "system",
          senderThreadId: null,
          queuedIds: [held.id],
          text: NOTICE_TEXT,
        },
      ]);
    });
  });

  it("returns a drained notice row to the queue on a plugin wait and consumes it once admitted", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("wait");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-drain",
        status: "idle",
      });
      const queued = createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: thread.id,
        content: textInput(NOTICE_TEXT),
        senderThreadId: null,
        origin: null,
        originPluginId: null,
        model: "fake-model",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: { kind: "child-completed", subject: SUBJECT },
      });

      await expect(
        sendNextQueuedMessageIfPresent(harness.deps, { threadId: thread.id }),
      ).resolves.toBe(true);

      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(turnSubmits(harness, thread.id)).toEqual([]);
      expect(expectHeldNotice(harness, thread.id).id).toBe(queued.id);

      gate.decision = "proceed";
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(getQueuedThreadMessage(harness.db, queued.id)).not.toBeNull();

      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2_000 });
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expectDeliveredOnce(harness, thread.id);

      expect(gate.seen.map((pass) => pass.queuedIds)).toEqual([
        [queued.id],
        [queued.id],
      ]);
      expect(gate.seen.every((pass) => pass.initiator === "system")).toBe(true);
    });
  });

  it("steers an active parent's notice into the running turn after a join-turn pass", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("proceed");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-steer",
        status: "active",
      });

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);

      expect(gate.seen.map((pass) => pass.attempt)).toEqual(["join-turn"]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      const requests = systemTurnRequests(harness, thread.id);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        systemMessageKind: "child-completed",
        systemMessageSubject: SUBJECT,
        target: { kind: "auto", expectedTurnId: "turn-host-notice-steer" },
      });
      expect(turnSubmits(harness, thread.id)).toEqual([
        expect.objectContaining({
          target: { mode: "auto", expectedTurnId: "turn-host-notice-steer" },
        }),
      ]);
    });
  });

  it("delivers at once with no pass when no plugin answers the hook", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedParent(harness, {
        hostId: "host-notice-nohook",
        status: "idle",
      });

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);

      expectDeliveredOnce(harness, thread.id);
      expect(systemTurnRequests(harness, thread.id)[0]).toMatchObject({
        target: { kind: "new-turn" },
      });
    });
  });

  it("keeps a refused notice on the queue with the plugin's reason instead of dropping it", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("reject");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-reject",
        status: "idle",
      });

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      const row = onlyRow(harness, thread.id);
      expect(JSON.parse(row.systemNotice!)).toEqual({
        kind: "child-completed",
        subject: SUBJECT,
      });

      await expect
        .poll(() => getQueuedThreadMessage(harness.db, row.id)?.failureReason)
        .toBe("memory unavailable");
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(turnSubmits(harness, thread.id)).toEqual([]);
      expect(gate.seen.length).toBeGreaterThanOrEqual(2);
    });
  });
  it("re-decides a notice as a new turn when the parent's turn ends during a join-turn pass", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("proceed");
      const hostId = "host-notice-flip";
      const { environment, thread } = seedParent(harness, {
        hostId,
        status: "active",
      });
      gate.duringPass = () =>
        endTurnDuringPass(harness, {
          environmentId: environment.id,
          hostId,
          threadId: thread.id,
        });

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);

      expect(gate.seen.map((pass) => pass.attempt)).toEqual([
        "join-turn",
        "start-turn",
      ]);
      expectDeliveredOnce(harness, thread.id);
      expect(systemTurnRequests(harness, thread.id)[0]).toMatchObject({
        target: { kind: "new-turn" },
      });
    });
  });

  it("returns a cleared notice to the queue on a stopping wait instead of failing it", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("proceed");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-stopping",
        status: "stopping",
      });
      const queued = seedHeldNotice(harness, thread.id);

      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });

      expect(gate.seen.map((pass) => pass.queuedIds)).toEqual([[queued.id]]);
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(turnSubmits(harness, thread.id)).toEqual([]);
      const row = onlyRow(harness, thread.id);
      expect(row.id).toBe(queued.id);
      expect(row.claimToken).toBeNull();
      expect(row.failureReason).toBeNull();
      expect(toThreadQueuedMessage(row).waitingOn).toEqual({
        kind: "stopping",
      });
    });
  });

  it("steers a held notice into the parent's running turn once its wait clears", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("wait");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-held-steer",
        status: "active",
      });

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);
      expectHeldNotice(harness, thread.id);

      gate.decision = "proceed";
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2_000 });
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });

      expect(gate.seen.map((pass) => pass.attempt)).toEqual([
        "join-turn",
        "join-turn",
      ]);
      expectDeliveredOnce(harness, thread.id);
      expect(systemTurnRequests(harness, thread.id)[0]).toMatchObject({
        target: {
          kind: "auto",
          expectedTurnId: "turn-host-notice-held-steer",
        },
      });
    });
  });

  it("keeps a notice on the queue when the dispatch hook throws", async () => {
    await withTestHarness(async (harness) => {
      installGate("throw");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-throw",
        status: "idle",
      });

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);

      const row = onlyRow(harness, thread.id);
      expect(JSON.parse(row.systemNotice!)).toEqual({
        kind: "child-completed",
        subject: SUBJECT,
      });
      await expect
        .poll(() => getQueuedThreadMessage(harness.db, row.id)?.failureReason)
        .toContain("memory");
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(turnSubmits(harness, thread.id)).toEqual([]);
    });
  });

  it("returns a claimed notice to an interaction wait when the parent opens a question during its wait", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("wait");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-interaction",
        status: "active",
      });

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);
      const held = expectHeldNotice(harness, thread.id);

      const pending = vi
        .spyOn(
          harness.deps.pendingInteractions,
          "hasTurnBoundPendingThreadInteraction",
        )
        .mockReturnValue(true);
      gate.decision = "proceed";
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2_000 });
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });

      const row = onlyRow(harness, thread.id);
      expect(row.id).toBe(held.id);
      expect(row.claimToken).toBeNull();
      expect(toThreadQueuedMessage(row).waitingOn).toEqual({
        kind: "interaction",
      });
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(turnSubmits(harness, thread.id)).toEqual([]);

      pending.mockReturnValue(false);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "interaction-settled",
        threadId: thread.id,
      });

      expectDeliveredOnce(harness, thread.id);
    });
  });

  it("does not deliver a claimed notice the user deletes while its hook runs", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("wait");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-cancelled",
        status: "idle",
      });

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);
      const held = expectHeldNotice(harness, thread.id);

      gate.decision = "proceed";
      gate.duringPass = () => {
        harness.db
          .delete(queuedThreadMessages)
          .where(eq(queuedThreadMessages.id, held.id))
          .run();
      };
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2_000 });
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });

      expect(gate.seen).toHaveLength(2);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(turnSubmits(harness, thread.id)).toEqual([]);
    });
  });
  it("delivers a notice once when a stop ends provisioning right after the pass settles", async () => {
    await withTestHarness(async (harness) => {
      installGate("proceed");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-stop-direct",
        status: "idle",
      });
      markStarting(harness, thread.id);
      stopRightAfterSettling(harness, thread.id);

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);

      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });

      expectDeliveredOnce(harness, thread.id);
    });
  });

  it("delivers a claimed notice once when a stop ends provisioning right after the pass settles", async () => {
    await withTestHarness(async (harness) => {
      installGate("proceed");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-stop-claimed",
        status: "idle",
      });
      markStarting(harness, thread.id);
      seedHeldNotice(harness, thread.id);
      stopRightAfterSettling(harness, thread.id);

      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);

      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });

      expectDeliveredOnce(harness, thread.id);
    });
  });

  it("holds a notice on a stopping wait when the parent starts stopping during its pass", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("proceed");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-direct-stopping",
        status: "idle",
      });
      gate.duringPass = () => setStatus(harness, thread.id, "stopping");

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);

      expect(gate.seen).toHaveLength(2);
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(turnSubmits(harness, thread.id)).toEqual([]);
      const row = onlyRow(harness, thread.id);
      expect(row.failureReason).toBeNull();
      expect(toThreadQueuedMessage(row).waitingOn).toEqual({
        kind: "stopping",
      });

      setStatus(harness, thread.id, "idle");
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });

      expectDeliveredOnce(harness, thread.id);
    });
  });

  it("queues a notice as thread-busy when the parent changes again during the second pass", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("proceed");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-two-flips",
        status: "idle",
      });
      gate.duringPass = () => {
        setStatus(harness, thread.id, "stopping");
        gate.duringPass = () => setStatus(harness, thread.id, "idle");
      };

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(true);

      expect(gate.seen).toHaveLength(2);
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      const row = onlyRow(harness, thread.id);
      expect(row.claimToken).toBeNull();
      expect(toThreadQueuedMessage(row).waitingOn).toEqual({
        kind: "thread-busy",
      });

      await expect.poll(() => turnSubmits(harness, thread.id).length).toBe(1);
      expectDeliveredOnce(harness, thread.id);
    });
  });

  it("drops a notice whose parent is archived during its pass", async () => {
    await withTestHarness(async (harness) => {
      const gate = installGate("proceed");
      const { thread } = seedParent(harness, {
        hostId: "host-notice-archived",
        status: "idle",
      });
      gate.duringPass = () => {
        harness.db
          .update(threads)
          .set({ archivedAt: Date.now() })
          .where(eq(threads.id, thread.id))
          .run();
      };

      await expect(queueChildCompleted(harness, thread.id)).resolves.toBe(
        false,
      );

      expect(gate.seen).toHaveLength(1);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(systemTurnRequests(harness, thread.id)).toEqual([]);
      expect(turnSubmits(harness, thread.id)).toEqual([]);
    });
  });
});
