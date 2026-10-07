import { eq } from "drizzle-orm";
import {
  getLatestThreadSequence,
  getThreadParentNoticesMode,
  listEvents,
  listQueuedThreadMessages,
  threads,
} from "@bb/db";
import {
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
  type ParentNoticesMode,
  type ThreadEventTurnStatus,
} from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { threadResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import {
  queueChildThreadNeedsAttentionNotificationBestEffort,
  queueChildThreadTurnNotificationBestEffort,
} from "../../src/services/threads/child-thread-notifications.js";
import {
  flushChildThreadNotifications,
  withChildThreadNotificationClock,
} from "../helpers/child-thread-notification-clock.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEvent,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface Family {
  child: ReturnType<typeof seedThread>;
  environmentId: string;
  parent: ReturnType<typeof seedThread>;
  projectId: string;
  sessionId: string;
}

const MODES = ["turns", "explicit"] as const;

function seedFamily(harness: TestAppHarness): Family {
  const {
    project,
    environment,
    session,
    thread: parent,
  } = seedThreadFixture(harness);
  seedThreadRuntimeState(harness.deps, {
    threadId: parent.id,
    environmentId: environment.id,
    providerThreadId: "parent-provider-thread",
  });
  const child = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    parentThreadId: parent.id,
    status: "idle",
    title: "Worker",
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: child.id,
    environmentId: environment.id,
    providerThreadId: "child-provider-thread",
    inputText: "Do the work",
  });
  return {
    child,
    environmentId: environment.id,
    parent,
    projectId: project.id,
    sessionId: session.id,
  };
}

async function setMode(
  harness: TestAppHarness,
  threadId: string,
  mode: ParentNoticesMode,
) {
  const response = await harness.app.request(`/api/v1/threads/${threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentNotices: mode }),
  });
  expect(response.status).toBe(200);
  return threadResponseSchema.parse(await response.json());
}

function systemNoticesTo(harness: TestAppHarness, parentThreadId: string) {
  const delivered = listEvents(harness.db, { threadId: parentThreadId })
    .filter((row) => row.type === "client/turn/requested")
    .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
    .filter((data) => data.initiator === "system")
    .map((data) => data.systemMessageKind);
  const queued = listQueuedThreadMessages(harness.db, parentThreadId)
    .filter((row) => row.systemNotice !== null)
    .map((row) => (JSON.parse(row.systemNotice!) as { kind: string }).kind);
  return [...delivered, ...queued];
}

async function endChildTurnThroughEvents(
  harness: TestAppHarness,
  family: Family,
  status: ThreadEventTurnStatus,
) {
  seedTurnStarted(harness.deps, {
    environmentId: family.environmentId,
    providerThreadId: "child-provider-thread",
    threadId: family.child.id,
    turnId: "child-turn",
  });
  harness.db
    .update(threads)
    .set({ status: status === "interrupted" ? "stopping" : "active" })
    .where(eq(threads.id, family.child.id))
    .run();
  if (status === "interrupted") {
    seedEvent(harness.deps, {
      threadId: family.child.id,
      environmentId: family.environmentId,
      providerThreadId: "child-provider-thread",
      sequence:
        getLatestThreadSequence(harness.db, { threadId: family.child.id }) + 1,
      type: "system/thread/interrupted",
      scope: threadScope(),
      data: { reason: "host-daemon-restarted" },
    });
  }
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId: family.sessionId,
      eventGroups: groupHostDaemonEvents([
        {
          threadId: family.child.id,
          event: {
            type: "turn/completed",
            threadId: family.child.id,
            providerThreadId: "child-provider-thread",
            scope: turnScope("child-turn"),
            status,
          },
        },
      ]),
    }),
  });
  expect(response.status).toBe(200);
  await flushChildThreadNotifications();
}

describe.each(["completed", "failed", "interrupted"] as const)(
  "a child's %s turn",
  (status) => {
    it.each(MODES)(
      "notifies the parent only in turns mode (%s)",
      async (mode) => {
        await withChildThreadNotificationClock(async (harness) => {
          const family = seedFamily(harness);
          await setMode(harness, family.child.id, mode);
          await endChildTurnThroughEvents(harness, family, status);
          expect(systemNoticesTo(harness, family.parent.id)).toEqual(
            mode === "turns" ? [`child-${status}`] : [],
          );
        });
      },
    );
  },
);

describe("final reports only", () => {
  it("drops command-failure notices too", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const family = seedFamily(harness);
      await setMode(harness, family.child.id, "explicit");
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: family.child,
        parentThreadId: family.parent.id,
        turnStatus: "failed",
        failureContext: "failed to start",
      });
      await flushChildThreadNotifications();
      expect(systemNoticesTo(harness, family.parent.id)).toEqual([]);
    });
  });

  it("still tells the parent when the child needs input", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const family = seedFamily(harness);
      await setMode(harness, family.child.id, "explicit");
      await queueChildThreadNeedsAttentionNotificationBestEffort(harness.deps, {
        blockerSummary: "Blocked on a question.",
        childThread: family.child,
        parentThreadId: family.parent.id,
      });
      expect(systemNoticesTo(harness, family.parent.id)).toEqual([
        "child-needs-attention",
      ]);
    });
  });

  it("still delivers the child's own messages to the parent", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const family = seedFamily(harness);
      await setMode(harness, family.child.id, "explicit");
      const response = await harness.app.request(
        `/api/v1/threads/${family.parent.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: textInput("Final report: done"),
            mode: "queue-if-active",
            senderThreadId: family.child.id,
          }),
        },
      );
      expect(response.status).toBe(200);
      const fromChild = listEvents(harness.db, { threadId: family.parent.id })
        .filter((row) => row.type === "client/turn/requested")
        .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
        .filter((data) => data.senderThreadId === family.child.id);
      expect(fromChild).toHaveLength(1);
    });
  });
});

describe("parent notices mode", () => {
  it("is set, read and reset through the thread API", async () => {
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness);
      expect(getThreadParentNoticesMode(harness.db, family.child.id)).toBe(
        "turns",
      );
      expect(
        (await setMode(harness, family.child.id, "explicit")).parentNotices,
      ).toBe("explicit");
      const read = await harness.app.request(
        `/api/v1/threads/${family.child.id}`,
      );
      expect(threadResponseSchema.parse(await read.json()).parentNotices).toBe(
        "explicit",
      );
      expect(
        (await setMode(harness, family.child.id, "turns")).parentNotices,
      ).toBe("turns");
    });
  });

  it("is set at spawn", async () => {
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness);
      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "app",
          projectId: family.projectId,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Worker task" }],
          environment: { type: "reuse", environmentId: family.environmentId },
          parentThreadId: family.parent.id,
          parentNotices: "explicit",
        }),
      });
      expect(response.status).toBe(201);
      const created = threadResponseSchema.parse(await response.json());
      expect(created.parentNotices).toBe("explicit");
      expect(getThreadParentNoticesMode(harness.db, created.id)).toBe(
        "explicit",
      );
    });
  });
});
