import {
  getThread,
  listEvents,
  listQueuedThreadMessages,
  setQueuedThreadMessageFailureReason,
} from "@bb/db";
import {
  turnRequestEventDataSchema,
  type PromptInput,
  type ThreadQueuedMessage,
  type TurnRequestEventData,
} from "@bb/domain";
import type {
  MessageDispatchHookContext,
  PluginHookName,
} from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import {
  requestQueuedMessageDispatch,
  runQueuedMessageDispatch,
} from "../../src/services/threads/queued-message-dispatch.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/batched-drain-project";

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

afterEach(() => {
  setPluginHookProvider(undefined);
  setPluginThreadEventEmitter(undefined);
});

function installHooks(registry: Partial<HookRegistry>): void {
  setPluginHookProvider({
    listHooks: (hook) => registry[hook] ?? [],
    invokeHook: async (_pluginId, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
}

function recordDispatchedRows(): string[] {
  const dispatched: string[] = [];
  setPluginThreadEventEmitter({
    emitThreadEvents: () => {},
    emitTerminalInput: () => {},
    emitHostDeleted: () => {},
    emitThreadCreated: () => {},
    emitThreadActive: () => {},
    emitThreadIdle: () => {},
    emitThreadFailed: () => {},
    emitThreadArchived: () => {},
    emitThreadDeleted: () => {},
    emitInteractionPending: () => {},
    emitMessageQueued: () => {},
    emitMessageDispatched: (entry: ThreadQueuedMessage) =>
      dispatched.push(entry.id),
    emitMessageCancelled: () => {},
    emitThreadUnarchived: () => {},
    emitTurnFailed: () => {},
  });
  return dispatched;
}

function seedBusyThread(
  harness: TestAppHarness,
  args: { hostId: string; providerId: string; senders: number },
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
    providerId: args.providerId,
    status: "active",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${args.hostId}`,
    threadId: thread.id,
  });
  seedTurnStarted(harness.deps, {
    environmentId: environment.id,
    threadId: thread.id,
    turnId: `turn-${args.hostId}`,
    providerThreadId: `provider-${args.hostId}`,
  });
  const senders = Array.from({ length: args.senders }, (_, index) =>
    seedThread(harness.deps, {
      projectId: project.id,
      title: `Worker ${index + 1}`,
    }),
  );
  return { senders, thread };
}

async function queueFrom(
  harness: TestAppHarness,
  args: { senderThreadId: string | null; text: string; threadId: string },
) {
  const target = getThread(harness.db, args.threadId)!;
  const response = await acceptThreadSendRequest(harness.deps, {
    payload: {
      input: textInput(args.text),
      mode: "queue-if-active",
      ...(args.senderThreadId !== null
        ? { senderThreadId: args.senderThreadId }
        : {}),
    },
    thread: target,
  });
  expect(response.delivery).toBe("queued");
}

async function endTurnAndDrain(harness: TestAppHarness, threadId: string) {
  applyLoggedThreadLifecycleEvent(harness.deps, {
    event: { type: "run.succeeded" },
    threadId,
  });
  await runQueuedMessageDispatch(harness.deps, {
    kind: "thread-ready",
    threadId,
  });
}

function turnRequests(
  harness: TestAppHarness,
  threadId: string,
): TurnRequestEventData[] {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)));
}

function groupText(group: readonly PromptInput[]): string {
  return group.map((item) => (item.type === "text" ? item.text : "")).join("");
}

const SENT_AT = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`;

function expectLabelledGroup(
  group: readonly PromptInput[],
  senderThreadId: string,
  body: string,
): void {
  expect(groupText(group)).toMatch(
    new RegExp(
      `^\\[bb message from thread:${senderThreadId}; sent ${SENT_AT}\\]\\n\\n${body}$`,
    ),
  );
}

describe("batched queue drain", () => {
  it.each([
    ["codex", "no dispatch hook"],
    ["claude-code", "no dispatch hook"],
    ["codex", "a dispatch hook"],
    ["claude-code", "a dispatch hook"],
  ] as const)(
    "runs every queued agent message as one turn on %s with %s",
    async (providerId, hooks) => {
      await withTestHarness(async (harness) => {
        const contexts: MessageDispatchHookContext[] = [];
        if (hooks === "a dispatch hook") {
          installHooks({
            "message.dispatch": [
              {
                pluginId: "observer",
                handler: (context) => {
                  contexts.push(context);
                  return { action: "proceed" } as const;
                },
              },
            ],
          });
        }
        const dispatched = recordDispatchedRows();
        const { senders, thread } = seedBusyThread(harness, {
          hostId: `host-batch-${providerId}-${hooks.length}`,
          providerId,
          senders: 3,
        });
        for (const [index, sender] of senders.entries()) {
          await queueFrom(harness, {
            senderThreadId: sender.id,
            text: `Report ${index + 1}`,
            threadId: thread.id,
          });
        }
        const queuedIds = listQueuedThreadMessages(harness.db, thread.id).map(
          (row) => row.id,
        );
        expect(queuedIds).toHaveLength(3);
        const requestsBefore = turnRequests(harness, thread.id).length;
        contexts.length = 0;

        await endTurnAndDrain(harness, thread.id);

        const requests = turnRequests(harness, thread.id).slice(requestsBefore);
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        expect(request.initiator).toBe("agent");
        expect(request.senderThreadId).toBe(senders[0]!.id);
        expect(request.inputGroups).toHaveLength(3);
        for (const [index, sender] of senders.entries()) {
          expectLabelledGroup(
            request.inputGroups![index]!,
            sender.id,
            `Report ${index + 1}`,
          );
        }
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
        expect(dispatched).toEqual(queuedIds);

        const submitted = listQueuedThreadCommands(
          harness,
          "turn.submit",
          thread.id,
        );
        expect(submitted).toHaveLength(1);
        const submittedText = groupText(
          (submitted[0] as { input: PromptInput[] }).input,
        );
        for (const sender of senders) {
          expect(submittedText).toContain(
            `[bb message from thread:${sender.id}; sent `,
          );
        }

        if (hooks === "a dispatch hook") {
          expect(contexts).toHaveLength(1);
          expect(contexts[0]!.senderThreadId).toBe("mixed");
          expect(contexts[0]!.initiator).toBe("agent");
          expect(
            contexts[0]!.queuedMessages.map((message) => message.id),
          ).toEqual(queuedIds);
        }
      });
    },
  );

  it("keeps a user's queued message in its own turn, in queue order", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-batch-user-boundary",
        providerId: "codex",
        senders: 3,
      });
      await queueFrom(harness, {
        senderThreadId: senders[0]!.id,
        text: "Report 1",
        threadId: thread.id,
      });
      await queueFrom(harness, {
        senderThreadId: senders[1]!.id,
        text: "Report 2",
        threadId: thread.id,
      });
      await queueFrom(harness, {
        senderThreadId: null,
        text: "Pause the slot work",
        threadId: thread.id,
      });
      await queueFrom(harness, {
        senderThreadId: senders[2]!.id,
        text: "Report 3",
        threadId: thread.id,
      });
      const requestsBefore = turnRequests(harness, thread.id).length;

      await endTurnAndDrain(harness, thread.id);
      let requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.inputGroups).toHaveLength(2);
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) =>
          groupText(JSON.parse(row.content) as PromptInput[]),
        ),
      ).toEqual(["Pause the slot work", "Report 3"]);

      await endTurnAndDrain(harness, thread.id);
      requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.initiator).toBe("user");
      expect(requests[1]!.inputGroups).toBeUndefined();
      expect(groupText(requests[1]!.input)).toBe("Pause the slot work");

      await endTurnAndDrain(harness, thread.id);
      requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests).toHaveLength(3);
      expect(groupText(requests[2]!.input)).toBe(
        `[bb message from thread:${senders[2]!.id}]\n\nReport 3`,
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("leaves a single queued agent message unlabelled with a time", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-batch-single",
        providerId: "codex",
        senders: 1,
      });
      await queueFrom(harness, {
        senderThreadId: senders[0]!.id,
        text: "Only report",
        threadId: thread.id,
      });
      const requestsBefore = turnRequests(harness, thread.id).length;

      await endTurnAndDrain(harness, thread.id);

      const requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.inputGroups).toBeUndefined();
      expect(groupText(requests[0]!.input)).toBe(
        `[bb message from thread:${senders[0]!.id}]\n\nOnly report`,
      );
    });
  });

  it("delivers a steer into the running turn and batches the queue after it", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-batch-steer",
        providerId: "codex",
        senders: 2,
      });
      await queueFrom(harness, {
        senderThreadId: senders[0]!.id,
        text: "Report 1",
        threadId: thread.id,
      });
      const requestsBefore = turnRequests(harness, thread.id).length;
      const steer = await acceptThreadSendRequest(harness.deps, {
        payload: {
          input: textInput("Blocked: need a decision"),
          mode: "steer-if-active",
          senderThreadId: senders[1]!.id,
        },
        thread: getThread(harness.db, thread.id)!,
      });
      expect(steer.delivery).toBe("sent");
      const steered = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(steered).toHaveLength(1);
      expect(steered[0]!.target.kind).toBe("steer");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);

      await queueFrom(harness, {
        senderThreadId: senders[1]!.id,
        text: "Report 2",
        threadId: thread.id,
      });
      await endTurnAndDrain(harness, thread.id);

      const requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.target.kind).toBe("new-turn");
      expect(requests[1]!.inputGroups).toHaveLength(2);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("batches rows already queued when the server starts", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-batch-recovery",
        providerId: "codex",
        senders: 3,
      });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.succeeded" },
        threadId: thread.id,
      });
      for (const [index, sender] of senders.entries()) {
        seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: textInput(`Report ${index + 1}`),
          senderThreadId: sender.id,
          waitingOn: { kind: "thread-busy" },
        });
      }
      const requestsBefore = turnRequests(harness, thread.id).length;

      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });

      const requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.inputGroups).toHaveLength(3);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("puts every row of a batch back when its turn cannot start, and sends them once later", async () => {
    await withTestHarness(async (harness) => {
      let refuse = true;
      installHooks({
        "message.dispatch": [
          {
            pluginId: "limiter",
            handler: () =>
              refuse
                ? ({ action: "wait", reason: "At capacity" } as const)
                : ({ action: "proceed" } as const),
          },
        ],
      });
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-batch-refused",
        providerId: "codex",
        senders: 2,
      });
      for (const [index, sender] of senders.entries()) {
        await queueFrom(harness, {
          senderThreadId: sender.id,
          text: `Report ${index + 1}`,
          threadId: thread.id,
        });
      }
      const requestsBefore = turnRequests(harness, thread.id).length;

      await endTurnAndDrain(harness, thread.id);

      expect(turnRequests(harness, thread.id).slice(requestsBefore)).toEqual(
        [],
      );
      const held = listQueuedThreadMessages(harness.db, thread.id);
      expect(held.map((row) => row.senderThreadId)).toEqual(
        senders.map((sender) => sender.id),
      );
      expect(held.every((row) => row.claimToken === null)).toBe(true);

      refuse = false;
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });

      // The recheck sends Report 1, which starts a turn; Report 2 waits for
      // that turn to end instead of joining it.
      let requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests.map((request) => request.target.kind)).toEqual([
        "new-turn",
      ]);
      expect(groupText(requests[0]!.input)).toMatch(/Report 1$/);
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => [
          row.senderThreadId,
          JSON.parse(row.waitingOn!),
        ]),
      ).toEqual([[senders[1]!.id, { kind: "thread-busy" }]]);

      await endTurnAndDrain(harness, thread.id);
      requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests.map((request) => request.target.kind)).toEqual([
        "new-turn",
        "new-turn",
      ]);
      expect(groupText(requests[1]!.input)).toMatch(/Report 2$/);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("does not merge a failed row into the batch", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-batch-failed",
        providerId: "codex",
        senders: 3,
      });
      for (const [index, sender] of senders.entries()) {
        await queueFrom(harness, {
          senderThreadId: sender.id,
          text: `Report ${index + 1}`,
          threadId: thread.id,
        });
      }
      const failed = listQueuedThreadMessages(harness.db, thread.id)[1]!;
      setQueuedThreadMessageFailureReason(harness.db, harness.deps.hub, {
        id: failed.id,
        threadId: thread.id,
        failureReason: "host unreachable",
        now: Date.now(),
        retryDelaysMs: [60_000],
      });
      const requestsBefore = turnRequests(harness, thread.id).length;

      await endTurnAndDrain(harness, thread.id);

      const requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.inputGroups!.map(groupText)).toEqual([
        expect.stringMatching(/Report 1$/),
        expect.stringMatching(/Report 3$/),
      ]);
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id),
      ).toEqual([failed.id]);
    });
  });
});

describe("queued rows and a running turn", () => {
  function seedHeldAgentRows(
    harness: TestAppHarness,
    args: {
      senders: readonly { id: string }[];
      threadId: string;
      waitingOn: Parameters<typeof seedQueuedMessage>[1]["waitingOn"];
    },
  ) {
    return args.senders.map((sender, index) =>
      seedQueuedMessage(harness.deps, {
        threadId: args.threadId,
        content: textInput(`Report ${index + 1}`),
        senderThreadId: sender.id,
        waitingOn: args.waitingOn,
      }),
    );
  }

  function queueState(harness: TestAppHarness, threadId: string) {
    return listQueuedThreadMessages(harness.db, threadId).map((row) => ({
      claimed: row.claimToken !== null,
      senderThreadId: row.senderThreadId,
      waitingOn: row.waitingOn === null ? null : JSON.parse(row.waitingOn),
    }));
  }

  it("keeps rows whose plugin wait clears out of the running turn", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-unregistered-active",
        providerId: "codex",
        senders: 2,
      });
      seedHeldAgentRows(harness, {
        senders,
        threadId: thread.id,
        waitingOn: { kind: "plugin", pluginId: "limiter", reason: "Full" },
      });
      const requestsBefore = turnRequests(harness, thread.id).length;

      await runQueuedMessageDispatch(harness.deps, {
        kind: "plugin-unregistered",
        pluginId: "limiter",
      });

      expect(turnRequests(harness, thread.id).slice(requestsBefore)).toEqual(
        [],
      );
      expect(queueState(harness, thread.id)).toEqual(
        senders.map((sender) => ({
          claimed: false,
          senderThreadId: sender.id,
          waitingOn: null,
        })),
      );

      await endTurnAndDrain(harness, thread.id);
      const requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.target.kind).toBe("new-turn");
      expect(requests[0]!.inputGroups).toHaveLength(2);
    });
  });

  it("queues a rechecked row behind the running turn instead of joining it", async () => {
    await withTestHarness(async (harness) => {
      installHooks({
        "message.dispatch": [
          {
            pluginId: "limiter",
            handler: () => ({ action: "proceed" }) as const,
          },
        ],
      });
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-recheck-active",
        providerId: "codex",
        senders: 1,
      });
      seedHeldAgentRows(harness, {
        senders,
        threadId: thread.id,
        waitingOn: { kind: "plugin", pluginId: "limiter", reason: "Full" },
      });
      const requestsBefore = turnRequests(harness, thread.id).length;

      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });

      expect(turnRequests(harness, thread.id).slice(requestsBefore)).toEqual(
        [],
      );
      expect(queueState(harness, thread.id)).toEqual([
        {
          claimed: false,
          senderThreadId: senders[0]!.id,
          waitingOn: { kind: "thread-busy" },
        },
      ]);

      await endTurnAndDrain(harness, thread.id);
      const requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests.map((request) => request.target.kind)).toEqual([
        "new-turn",
      ]);
    });
  });

  it("puts a batch back when a turn starts while it is being prepared", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-race",
        providerId: "codex",
        senders: 2,
      });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.succeeded" },
        threadId: thread.id,
      });
      seedHeldAgentRows(harness, {
        senders,
        threadId: thread.id,
        waitingOn: { kind: "thread-busy" },
      });
      let raced = false;
      installHooks({
        "message.dispatch": [
          {
            pluginId: "observer",
            handler: () => {
              if (!raced) {
                raced = true;
                applyLoggedThreadLifecycleEvent(harness.deps, {
                  event: { type: "run.started" },
                  threadId: thread.id,
                });
                seedTurnStarted(harness.deps, {
                  environmentId: thread.environmentId!,
                  threadId: thread.id,
                  turnId: "turn-race-2",
                  providerThreadId: "provider-host-race",
                });
              }
              return { action: "proceed" } as const;
            },
          },
        ],
      });
      const requestsBefore = turnRequests(harness, thread.id).length;

      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });

      expect(raced).toBe(true);
      expect(turnRequests(harness, thread.id).slice(requestsBefore)).toEqual(
        [],
      );
      expect(queueState(harness, thread.id)).toEqual(
        senders.map((sender) => ({
          claimed: false,
          senderThreadId: sender.id,
          waitingOn: { kind: "thread-busy" },
        })),
      );

      await endTurnAndDrain(harness, thread.id);
      const requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.target.kind).toBe("new-turn");
      expect(requests[0]!.inputGroups).toHaveLength(2);
    });
  });

  it("still steers a row held for an interaction into the turn that asked", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-interaction-active",
        providerId: "codex",
        senders: 1,
      });
      seedHeldAgentRows(harness, {
        senders,
        threadId: thread.id,
        waitingOn: { kind: "interaction" },
      });
      const requestsBefore = turnRequests(harness, thread.id).length;

      await runQueuedMessageDispatch(harness.deps, {
        kind: "interaction-settled",
        threadId: thread.id,
      });

      const requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests.map((request) => request.target)).toEqual([
        { kind: "auto", expectedTurnId: "turn-host-interaction-active" },
      ]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("joins rows held for an interaction only into that turn, not its successor", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-interaction-race",
        providerId: "codex",
        senders: 2,
      });
      seedHeldAgentRows(harness, {
        senders,
        threadId: thread.id,
        waitingOn: { kind: "interaction" },
      });
      // While the second row is prepared, the turn that asked ends and the
      // next one starts.
      let hookCalls = 0;
      installHooks({
        "message.dispatch": [
          {
            pluginId: "observer",
            handler: () => {
              hookCalls += 1;
              if (hookCalls === 2) {
                applyLoggedThreadLifecycleEvent(harness.deps, {
                  event: { type: "run.succeeded" },
                  threadId: thread.id,
                });
                applyLoggedThreadLifecycleEvent(harness.deps, {
                  event: { type: "run.started" },
                  threadId: thread.id,
                });
                seedTurnStarted(harness.deps, {
                  environmentId: thread.environmentId!,
                  threadId: thread.id,
                  turnId: "turn-successor",
                  providerThreadId: "provider-host-interaction-race",
                });
              }
              return { action: "proceed" } as const;
            },
          },
        ],
      });
      const requestsBefore = turnRequests(harness, thread.id).length;

      await runQueuedMessageDispatch(harness.deps, {
        kind: "interaction-settled",
        threadId: thread.id,
      });

      expect(hookCalls).toBeGreaterThanOrEqual(2);
      const requests = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(requests.map((request) => request.target)).toEqual([
        { kind: "auto", expectedTurnId: "turn-host-interaction-race" },
      ]);
      expect(queueState(harness, thread.id)).toEqual([
        {
          claimed: false,
          senderThreadId: senders[1]!.id,
          waitingOn: { kind: "thread-busy" },
        },
      ]);

      await endTurnAndDrain(harness, thread.id);
      const later = turnRequests(harness, thread.id).slice(requestsBefore + 1);
      expect(later.map((request) => request.target.kind)).toEqual(["new-turn"]);
      expect(groupText(later[0]!.input)).toContain("Report 2");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("never joins a successor that starts before the settled wake runs", async () => {
    await withTestHarness(async (harness) => {
      const { senders, thread } = seedBusyThread(harness, {
        hostId: "host-interaction-deferred",
        providerId: "codex",
        senders: 1,
      });
      seedHeldAgentRows(harness, {
        senders,
        threadId: thread.id,
        waitingOn: { kind: "interaction" },
      });
      const requestsBefore = turnRequests(harness, thread.id).length;

      // The interaction settles; its wake runs after the turn that asked has
      // ended and the user's next turn has started.
      vi.useFakeTimers();
      try {
        requestQueuedMessageDispatch(harness.deps, {
          kind: "interaction-settled",
          threadId: thread.id,
        });
        expect(vi.getTimerCount()).toBe(1);
        applyLoggedThreadLifecycleEvent(harness.deps, {
          event: { type: "run.succeeded" },
          threadId: thread.id,
        });
        applyLoggedThreadLifecycleEvent(harness.deps, {
          event: { type: "run.started" },
          threadId: thread.id,
        });
        seedTurnStarted(harness.deps, {
          environmentId: thread.environmentId!,
          threadId: thread.id,
          turnId: "turn-successor",
          providerThreadId: "provider-host-interaction-deferred",
        });
        await vi.runAllTimersAsync();
      } finally {
        vi.useRealTimers();
      }

      expect(turnRequests(harness, thread.id).slice(requestsBefore)).toEqual(
        [],
      );
      expect(queueState(harness, thread.id)).toEqual([
        {
          claimed: false,
          senderThreadId: senders[0]!.id,
          waitingOn: null,
        },
      ]);

      await endTurnAndDrain(harness, thread.id);
      const later = turnRequests(harness, thread.id).slice(requestsBefore);
      expect(later.map((request) => request.target.kind)).toEqual(["new-turn"]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });
});
