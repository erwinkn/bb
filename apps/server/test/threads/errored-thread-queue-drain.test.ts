import {
  createQueuedThreadMessage,
  getLatestThreadSequence,
  getThread,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  turnScope,
  type QueuedMessageWaitingOn,
} from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { ERRORED_THREAD_QUEUE_GRACE_MS } from "../../src/services/threads/errored-thread-queue.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/errored-thread-queue-drain";

afterEach(() => {
  vi.useRealTimers();
});

function seedFailedThread(
  harness: TestAppHarness,
  args: { hostId: string; accepted: boolean },
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
    status: "active",
  });
  const providerThreadId = `provider-${args.hostId}`;
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId,
    threadId: thread.id,
  });
  if (args.accepted) {
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId,
      sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
      type: "turn/input/accepted",
      scope: turnScope(`turn-${args.hostId}`),
      data: {
        providerThreadId,
        clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      },
    });
  }
  applyLoggedThreadLifecycleEvent(harness.deps, {
    event: { type: "run.failed" },
    threadId: thread.id,
  });
  expect(getThread(harness.db, thread.id)?.status).toBe("error");
  return { thread };
}

function queueBehindTurn(
  harness: TestAppHarness,
  threadId: string,
  waitingOn: QueuedMessageWaitingOn,
) {
  return seedQueuedMessage(harness.deps, {
    threadId,
    content: textInput(`Message waiting on ${waitingOn.kind}`),
    senderThreadId: null,
    waitingOn,
  });
}

function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  );
}

async function sweepAfter(harness: TestAppHarness, elapsedMs: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + elapsedMs);
  await runQueuedMessageDispatch(harness.deps, {
    kind: "idle-recovery",
    now: Date.now(),
  });
}

describe("queued messages on a thread whose turn failed", () => {
  it.each([
    { kind: "thread-busy" },
    { kind: "turn-starting" },
  ] satisfies QueuedMessageWaitingOn[])(
    "dispatch a row waiting on $kind once the failure has settled",
    async (waitingOn) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedFailedThread(harness, {
          hostId: `host-errored-${waitingOn.kind}`,
          accepted: true,
        });
        queueBehindTurn(harness, thread.id, waitingOn);
        const turnsBefore = turnRequests(harness, thread.id).length;

        await sweepAfter(harness, ERRORED_THREAD_QUEUE_GRACE_MS + 1_000);

        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
        expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore + 1);
      });
    },
  );

  it("leaves the row alone while the failure is fresh", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedFailedThread(harness, {
        hostId: "host-errored-fresh",
        accepted: true,
      });
      const row = queueBehindTurn(harness, thread.id, { kind: "thread-busy" });
      const turnsBefore = turnRequests(harness, thread.id).length;

      await sweepAfter(harness, ERRORED_THREAD_QUEUE_GRACE_MS - 5_000);

      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((r) => r.id),
      ).toEqual([row.id]);
      expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore);
    });
  });

  it("leaves the row alone when the provider never accepted the failed turn", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedFailedThread(harness, {
        hostId: "host-errored-rejected",
        accepted: false,
      });
      const row = queueBehindTurn(harness, thread.id, { kind: "thread-busy" });
      const turnsBefore = turnRequests(harness, thread.id).length;

      await sweepAfter(harness, ERRORED_THREAD_QUEUE_GRACE_MS + 1_000);

      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((r) => r.id),
      ).toEqual([row.id]);
      expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore);
    });
  });

  it("leaves ordinary rows behind a retry that owns the recovery", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedFailedThread(harness, {
        hostId: "host-errored-retry",
        accepted: true,
      });
      const retry = createQueuedThreadMessage(harness.db, harness.deps.hub, {
        threadId: thread.id,
        content: textInput("Please continue."),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        senderThreadId: null,
        serviceTier: "default",
        waitingOn: { kind: "time" },
        sendAt: Date.now() + 10 * 60_000,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          attempt: 2,
          reason: "Rate limited",
        },
        systemNotice: null,
      });
      const row = queueBehindTurn(harness, thread.id, { kind: "thread-busy" });
      const turnsBefore = turnRequests(harness, thread.id).length;

      await sweepAfter(harness, ERRORED_THREAD_QUEUE_GRACE_MS + 1_000);

      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((r) => r.id),
      ).toEqual([retry.id, row.id]);
      expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore);
    });
  });
});
