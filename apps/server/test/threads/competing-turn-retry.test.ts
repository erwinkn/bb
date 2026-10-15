import {
  getLatestThreadSequence,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  queuedThreadMessages,
  setQueuedThreadMessageGroupBoundary,
  updateHost,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { COMPETING_TURN_RETRY_REASON } from "../../src/services/threads/competing-turn-retry.js";
import {
  createQueuedMessageForThread,
  sendNextQueuedMessageIfPresent,
} from "../../src/services/threads/queued-messages.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import {
  internalAuthHeaders,
  reportQueuedCommandError,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PROVIDER_THREAD_ID = "provider-competing-turn";
const PROVIDER_TURN_ID = "turn-provider-started";
const NOTICE = "W2015 reported (done) on A2304";
const HOST_ID = "host-competing-turn";

function seedCoordinator(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps, {
    id: HOST_ID,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/competing-turn",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/competing-turn",
    status: "ready",
  });
  const coordinator = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: coordinator.id,
  });
  const worker = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  const otherWorker = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  return {
    coordinator,
    environment,
    otherWorker,
    sessionId: session.id,
    worker,
  };
}

async function refuseAsCompetingTurn(
  harness: TestAppHarness,
  coordinator: { environmentId: string | null; id: string },
) {
  const refused = await waitForQueuedCommand(
    harness,
    (queued) =>
      queued.command.type === "turn.submit" &&
      queued.command.threadId === coordinator.id,
  );
  if (refused.command.type !== "turn.submit") {
    throw new Error("Expected a turn.submit command");
  }
  expect(refused.command.target).toEqual({ mode: "start" });
  seedTurnStarted(harness.deps, {
    environmentId: coordinator.environmentId!,
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: coordinator.id,
    turnId: PROVIDER_TURN_ID,
  });
  await reportQueuedCommandError(harness, refused, {
    errorCode: "competing_turn",
    errorMessage: `Refusing to start a competing turn for thread "${coordinator.id}" while another turn is active or starting`,
  });
  return { refused, requestId: refused.command.requestId };
}

async function sendNotice(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedCoordinator>,
) {
  await expect(
    acceptThreadSendRequest(harness.deps, {
      thread: fixture.coordinator,
      payload: {
        input: textInput(NOTICE),
        mode: "queue-if-active",
        senderThreadId: fixture.worker.id,
      },
    }),
  ).resolves.toMatchObject({ delivery: "sent" });
}

async function endProviderTurn(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedCoordinator>,
  status: "completed" | "failed",
) {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId: fixture.sessionId,
      eventGroups: groupHostDaemonEvents([
        {
          threadId: fixture.coordinator.id,
          event: {
            type: "turn/completed",
            threadId: fixture.coordinator.id,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(PROVIDER_TURN_ID),
            status,
          },
        },
      ]),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function waitForRetrySubmit(
  harness: TestAppHarness,
  afterCursor: number,
  threadId: string,
) {
  const retried = await waitForQueuedCommandAfter(
    harness,
    afterCursor,
    (candidate) =>
      candidate.command.type === "turn.submit" &&
      candidate.command.threadId === threadId,
  );
  if (retried.command.type !== "turn.submit") {
    throw new Error("Expected a turn.submit command");
  }
  return retried.command;
}

function turnRequestedData(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map(
      (event) =>
        JSON.parse(event.data) as {
          initiator: string;
          input: { text: string; visibility?: string }[];
          requestId: string;
          retryAttempt?: number;
          retryOfRequestId?: string;
        },
    );
}

describe("a new turn refused because the provider started its own", () => {
  it("waits behind that turn and runs once it ends", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedCoordinator(harness);
      const { coordinator } = fixture;
      await sendNotice(harness, fixture);
      const { refused, requestId: originalRequestId } =
        await refuseAsCompetingTurn(harness, coordinator);

      const events = listEvents(harness.db, { threadId: coordinator.id });
      expect(events.some((event) => event.type === "system/error")).toBe(false);
      expect(getThread(harness.db, coordinator.id)?.status).toBe("active");
      const queued = listQueuedThreadMessages(harness.db, coordinator.id).map(
        toThreadQueuedMessage,
      );
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        payload: {
          kind: "retry",
          retryOfTurnRequestId: originalRequestId,
          attempt: 2,
          reason: COMPETING_TURN_RETRY_REASON,
        },
        waitingOn: { kind: "thread-busy" },
      });

      await endProviderTurn(harness, fixture, "completed");

      const retried = await waitForRetrySubmit(
        harness,
        refused.row.cursor,
        coordinator.id,
      );
      expect(retried.target).toEqual({ mode: "start" });
      const retriedRequestId = retried.requestId;
      expect(listQueuedThreadMessages(harness.db, coordinator.id)).toEqual([]);

      const requests = turnRequestedData(harness, coordinator.id);
      const original = requests.find(
        (request) => request.requestId === originalRequestId,
      );
      const retry = requests.find(
        (request) => request.requestId === retriedRequestId,
      );
      expect(original?.initiator).toBe("agent");
      expect(retry).toMatchObject({
        initiator: "system",
        retryOfRequestId: originalRequestId,
        retryAttempt: 2,
      });
      expect(retry?.input.map((block) => block.text)).toEqual(
        original?.input.map((block) => block.text),
      );
      expect(retry?.input[0]?.text).toContain(NOTICE);
      expect(
        retry?.input.every((block) => block.visibility === "agent-only"),
      ).toBe(true);
    });
  });

  it("retries a turn the queue drained, with every message it carried", async () => {
    await withTestHarness(async (harness) => {
      const { coordinator, otherWorker, worker } = seedCoordinator(harness);
      seedQueuedMessage(harness.deps, {
        content: textInput("W1 reported"),
        senderThreadId: worker.id,
        threadId: coordinator.id,
      });
      seedQueuedMessage(harness.deps, {
        content: textInput("W2 reported"),
        senderThreadId: otherWorker.id,
        threadId: coordinator.id,
      });

      await expect(
        sendNextQueuedMessageIfPresent(harness.deps, {
          threadId: coordinator.id,
        }),
      ).resolves.toBe(true);
      const { requestId } = await refuseAsCompetingTurn(harness, coordinator);

      const refusedRequest = turnRequestedData(harness, coordinator.id).find(
        (request) => request.requestId === requestId,
      );
      const retries = listQueuedThreadMessages(harness.db, coordinator.id)
        .map(toThreadQueuedMessage)
        .filter((row) => row.payload.kind === "retry");
      expect(retries).toHaveLength(1);
      expect(retries[0]?.payload).toMatchObject({
        retryOfTurnRequestId: requestId,
      });
      expect(
        retries[0]?.content.map((block) =>
          block.type === "text" ? block.text : null,
        ),
      ).toEqual(refusedRequest?.input.map((block) => block.text));
    });
  });

  it("runs the retry when the provider's turn fails", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedCoordinator(harness);
      const { coordinator } = fixture;
      await sendNotice(harness, fixture);
      const { refused, requestId } = await refuseAsCompetingTurn(
        harness,
        coordinator,
      );

      await endProviderTurn(harness, fixture, "failed");
      expect(getThread(harness.db, coordinator.id)?.status).toBe("error");
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });

      const retried = await waitForRetrySubmit(
        harness,
        refused.row.cursor,
        coordinator.id,
      );
      expect(listQueuedThreadMessages(harness.db, coordinator.id)).toEqual([]);
      expect(
        turnRequestedData(harness, coordinator.id).find(
          (request) => request.requestId === retried.requestId,
        ),
      ).toMatchObject({ retryOfRequestId: requestId, retryAttempt: 2 });
    });
  });

  it("waits again instead of joining a turn that starts while the retry is sent", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedCoordinator(harness);
      const { coordinator, environment } = fixture;
      await sendNotice(harness, fixture);
      const { refused } = await refuseAsCompetingTurn(harness, coordinator);
      seedEvent(harness.deps, {
        threadId: coordinator.id,
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: coordinator.id }) + 1,
        type: "turn/completed",
        scope: turnScope(PROVIDER_TURN_ID),
        data: { providerThreadId: PROVIDER_THREAD_ID, status: "completed" },
      });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId: coordinator.id,
        event: { type: "run.succeeded" },
      });

      const draining = sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: coordinator.id,
      });
      seedTurnStarted(harness.deps, {
        threadId: coordinator.id,
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        turnId: "turn-next-provider",
      });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId: coordinator.id,
        event: { type: "run.started" },
      });
      await draining;

      expect(
        listQueuedThreadMessages(harness.db, coordinator.id).map(
          (row) => toThreadQueuedMessage(row).waitingOn,
        ),
      ).toEqual([{ kind: "thread-busy" }]);
      await expect(
        waitForRetrySubmit(harness, refused.row.cursor, coordinator.id),
      ).rejects.toThrow("Timed out");
    });
  });

  it("still records the refusal when the machine is being removed", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedCoordinator(harness);
      const { coordinator } = fixture;
      await sendNotice(harness, fixture);
      updateHost(harness.db, harness.hub, HOST_ID, { phase: "removing" });

      const { requestId } = await refuseAsCompetingTurn(harness, coordinator);

      const rejections = listEvents(harness.db, {
        threadId: coordinator.id,
      }).filter((event) => event.type === "client/turn/rejected");
      expect(rejections.map((event) => JSON.parse(event.data))).toMatchObject([
        { requestId, reason: "competing_turn" },
      ]);
      expect(listQueuedThreadMessages(harness.db, coordinator.id)).toEqual([]);
    });
  });

  it("keeps the retry out of the user's queued groups", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedCoordinator(harness);
      const { coordinator } = fixture;
      await sendNotice(harness, fixture);
      const { refused, requestId } = await refuseAsCompetingTurn(
        harness,
        coordinator,
      );
      const [retryRow] = listQueuedThreadMessages(harness.db, coordinator.id);
      if (retryRow === undefined) throw new Error("Expected a retry row");
      const retry = toThreadQueuedMessage(retryRow);
      const question = await createQueuedMessageForThread(harness.deps, {
        thread: getThread(harness.db, coordinator.id)!,
        payload: {
          input: textInput("User asks a new question"),
          model: retry.model,
          reasoningLevel: retry.reasoningLevel,
          permissionMode: retry.permissionMode,
          serviceTier: retry.serviceTier,
        },
      });

      expect(
        setQueuedThreadMessageGroupBoundary({
          db: harness.db,
          notifier: harness.hub,
          threadId: coordinator.id,
          expectedGroupedPrefixQueuedMessageIds: [retry.id, question.id],
          groupBoundaryQueuedMessageId: question.id,
        }).kind,
      ).toBe("invalid_sender");
      harness.db
        .update(queuedThreadMessages)
        .set({ groupWithNext: true })
        .where(eq(queuedThreadMessages.id, retry.id))
        .run();
      await endProviderTurn(harness, fixture, "completed");

      const retried = await waitForRetrySubmit(
        harness,
        refused.row.cursor,
        coordinator.id,
      );
      const request = turnRequestedData(harness, coordinator.id).find(
        (candidate) => candidate.requestId === retried.requestId,
      );
      expect(request).toMatchObject({ retryOfRequestId: requestId });
      expect(request?.input.map((block) => block.text).join("")).not.toContain(
        "User asks a new question",
      );
      expect(
        listQueuedThreadMessages(harness.db, coordinator.id).map(
          (row) => row.id,
        ),
      ).toEqual([question.id]);
    });
  });

  it("does not queue a retry when no other turn is running", async () => {
    await withTestHarness(async (harness) => {
      const { coordinator, worker } = seedCoordinator(harness);
      await acceptThreadSendRequest(harness.deps, {
        thread: coordinator,
        payload: {
          input: textInput(NOTICE),
          mode: "queue-if-active",
          senderThreadId: worker.id,
        },
      });
      const refused = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "turn.submit" &&
          queued.command.threadId === coordinator.id,
      );

      await reportQueuedCommandError(harness, refused, {
        errorCode: "competing_turn",
        errorMessage: "Refusing to start a competing turn",
      });

      expect(getThread(harness.db, coordinator.id)?.status).toBe("error");
      expect(listQueuedThreadMessages(harness.db, coordinator.id)).toEqual([]);
    });
  });
});
