import {
  getActiveStoredTurnId,
  getLatestThreadSequence,
  getThread,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import {
  groupHostDaemonEvents,
  HOST_DAEMON_PROTOCOL_VERSION,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectImportedDaemonSessions,
  handleDaemonSocketClosed,
} from "../../src/internal/session-owner-side-effects.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { ERRORED_THREAD_QUEUE_GRACE_MS } from "../../src/services/threads/errored-thread-queue.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  internalAuthHeaders,
  registerTestHostRpcCapture,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEvent,
  seedQueuedMessage,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const TURN_ID = "turn-running";
const PROVIDER_THREAD_ID = "provider-running";

afterEach(() => {
  vi.useRealTimers();
});

function seedRunningTurn(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, { thread: { status: "active" } });
  const { environment, thread } = fixture;
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: thread.id,
  });
  seedTurnStarted(harness.deps, {
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: thread.id,
    turnId: TURN_ID,
  });
  seedEvent(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
    type: "turn/input/accepted",
    scope: turnScope(TURN_ID),
    data: {
      providerThreadId: PROVIDER_THREAD_ID,
      clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
    },
  });
  return fixture;
}

async function reconnect(
  harness: TestAppHarness,
  args: { hostId: string; instanceId: string; liveThreadIds: string[] },
): Promise<string> {
  const response = await harness.app.request("/internal/session/open", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      hostId: args.hostId,
      instanceId: args.instanceId,
      hostName: "Test Host",
      hasMachineCredential: false,
      platform: "darwin",
      dataDir: `/tmp/bb-host-data/${args.hostId}`,
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: args.liveThreadIds.map((threadId) => ({ threadId })),
    }),
  });
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  registerTestHostRpcCapture(harness, { hostId: args.hostId, sessionId });
  return sessionId;
}

async function postDaemonEvents(
  harness: TestAppHarness,
  args: {
    hostId: string;
    sessionId: string;
    events: HostDaemonEventEnvelope[];
  },
): Promise<void> {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
    }),
  });
  expect(response.status).toBe(200);
}

function providerFinishesTurn(threadId: string): HostDaemonEventEnvelope[] {
  return [
    {
      threadId,
      event: {
        type: "item/completed",
        threadId,
        providerThreadId: PROVIDER_THREAD_ID,
        scope: turnScope(TURN_ID),
        item: {
          type: "agentMessage",
          id: "item-after-reconnect",
          text: "Done while the server was away.",
        },
      },
    },
    {
      threadId,
      event: {
        type: "turn/completed",
        threadId,
        providerThreadId: PROVIDER_THREAD_ID,
        scope: turnScope(TURN_ID),
        status: "completed",
      },
    },
  ];
}

function turnEvents(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((row) => row.turnId === TURN_ID)
    .filter(
      (row) => row.type === "turn/started" || row.type === "turn/completed",
    )
    .map((row) => ({
      type: row.type,
      status: (JSON.parse(row.data) as { status?: string }).status,
    }));
}

function interruptions(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (row) => row.type === "system/thread/interrupted",
  );
}

function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (row) => row.type === "client/turn/requested",
  );
}

function queueBehindTurn(harness: TestAppHarness, threadId: string) {
  return seedQueuedMessage(harness.deps, {
    threadId,
    content: textInput("Queued behind the running turn"),
    senderThreadId: null,
    waitingOn: { kind: "thread-busy" },
  });
}

describe("a daemon that comes back with the agent still running", () => {
  it("keeps the turn open through a long drop, then completes it and delivers the queue once", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedRunningTurn(harness);
      queueBehindTurn(harness, thread.id);
      const requestsBefore = turnRequests(harness, thread.id).length;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      vi.useRealTimers();

      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(interruptions(harness, thread.id)).toEqual([]);

      const sessionId = await reconnect(harness, {
        hostId: host.id,
        instanceId: session.instanceId,
        liveThreadIds: [thread.id],
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(getActiveStoredTurnId(harness.db, thread.id)).toBe(TURN_ID);

      await postDaemonEvents(harness, {
        hostId: host.id,
        sessionId,
        events: providerFinishesTurn(thread.id),
      });

      await vi.waitFor(() => {
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      });
      expect(turnEvents(harness, thread.id)).toEqual([
        { type: "turn/started", status: undefined },
        { type: "turn/completed", status: "completed" },
      ]);
      expect(turnRequests(harness, thread.id)).toHaveLength(requestsBefore + 1);
    });
  });

  it("re-adopts a turn BB closed while the daemon was away, instead of reviving the thread without a turn", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedRunningTurn(harness);
      harness.hub.unregisterDaemon(session.id);
      disconnectImportedDaemonSessions(harness.deps, {
        sessions: [{ hostId: host.id, id: session.id }],
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
      expect(getActiveStoredTurnId(harness.db, thread.id)).toBeNull();
      queueBehindTurn(harness, thread.id);
      const requestsBefore = turnRequests(harness, thread.id).length;

      const sessionId = await reconnect(harness, {
        hostId: host.id,
        instanceId: session.instanceId,
        liveThreadIds: [thread.id],
      });

      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(getActiveStoredTurnId(harness.db, thread.id)).toBe(TURN_ID);
      expect(interruptions(harness, thread.id)).toEqual([]);
      expect(turnEvents(harness, thread.id)).toEqual([
        { type: "turn/started", status: undefined },
      ]);

      await postDaemonEvents(harness, {
        hostId: host.id,
        sessionId,
        events: providerFinishesTurn(thread.id),
      });

      await vi.waitFor(() => {
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      });
      expect(getThread(harness.db, thread.id)?.status).not.toBe("error");
      expect(turnEvents(harness, thread.id)).toEqual([
        { type: "turn/started", status: undefined },
        { type: "turn/completed", status: "completed" },
      ]);
      expect(turnRequests(harness, thread.id)).toHaveLength(requestsBefore + 1);
    });
  });

  it("does not re-adopt for a different daemon instance, whose agents cannot be the old ones", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedRunningTurn(harness);
      harness.hub.unregisterDaemon(session.id);
      disconnectImportedDaemonSessions(harness.deps, {
        sessions: [{ hostId: host.id, id: session.id }],
      });

      await reconnect(harness, {
        hostId: host.id,
        instanceId: "instance-after-restart",
        liveThreadIds: [thread.id],
      });

      expect(getThread(harness.db, thread.id)?.status).toBe("error");
      expect(interruptions(harness, thread.id)).toHaveLength(1);
    });
  });
});

describe("a thread the daemon reports live without a turn to resume", () => {
  it("stays settled when its last turn already ended on the provider's side", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, session, thread } = seedRunningTurn(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "turn/completed",
        scope: turnScope(TURN_ID),
        data: { providerThreadId: PROVIDER_THREAD_ID, status: "failed" },
      });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.failed" },
        threadId: thread.id,
      });

      await reconnect(harness, {
        hostId: host.id,
        instanceId: session.instanceId,
        liveThreadIds: [thread.id],
      });

      expect(getThread(harness.db, thread.id)?.status).toBe("error");
    });
  });

  it("is revived when a turn request is waiting for its turn to start", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, session, thread } = seedRunningTurn(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "turn/completed",
        scope: turnScope(TURN_ID),
        data: { providerThreadId: PROVIDER_THREAD_ID, status: "failed" },
      });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.failed" },
        threadId: thread.id,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 2 }),
          input: [{ type: "text", text: "Next task" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });

      await reconnect(harness, {
        hostId: host.id,
        instanceId: session.instanceId,
        liveThreadIds: [thread.id],
      });

      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    });
  });
});

describe("a daemon that comes back without the agent", () => {
  it("settles the thread and drains its queue once the failure has settled", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedRunningTurn(harness);
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      await reconnect(harness, {
        hostId: host.id,
        instanceId: session.instanceId,
        liveThreadIds: [],
      });

      expect(getThread(harness.db, thread.id)?.status).toBe("error");
      expect(turnEvents(harness, thread.id)).toEqual([
        { type: "turn/started", status: undefined },
        { type: "turn/completed", status: "interrupted" },
      ]);
      expect(
        interruptions(harness, thread.id).map((row) => JSON.parse(row.data)),
      ).toEqual([
        { reason: "host-daemon-restarted", cause: "host-connection-lost" },
      ]);

      queueBehindTurn(harness, thread.id);
      const requestsBefore = turnRequests(harness, thread.id).length;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + ERRORED_THREAD_QUEUE_GRACE_MS + 1_000);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });

      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(turnRequests(harness, thread.id)).toHaveLength(requestsBefore + 1);
    });
  });
});
