import { listEvents } from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
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

const CURRENT_SESSION = "claude-session-current";
const OLD_SESSION = "claude-session-old";

interface StopFixture {
  environmentId: string;
  hostId: string;
  sessionId: string;
  threadId: string;
}

function seedClaudeThread(
  harness: TestAppHarness,
  providerId = "claude-code",
): StopFixture {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: CURRENT_SESSION,
    threadId: thread.id,
  });
  return {
    environmentId: environment.id,
    hostId: host.id,
    sessionId: session.id,
    threadId: thread.id,
  };
}

function seedRunningCommand(
  harness: TestAppHarness,
  fixture: StopFixture,
  args: { itemId: string; taskId: string; providerThreadId: string },
  sequence: number,
): void {
  seedStoredEvent(harness.deps, {
    threadId: fixture.threadId,
    environmentId: fixture.environmentId,
    sequence,
    type: "item/started",
    scope: turnScope(`turn-${sequence}`),
    providerThreadId: args.providerThreadId,
    itemId: args.itemId,
    itemKind: "backgroundTask",
    data: {
      providerThreadId: args.providerThreadId,
      item: {
        id: args.itemId,
        type: "backgroundTask",
        familyId: args.taskId,
        taskType: "local_bash",
        description: "Collect slots",
        status: "pending",
        taskStatus: "running",
        skipTranscript: false,
      },
    },
  });
}

function settledTasks(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.deps.db, { threadId })
    .filter((row) => row.type === "item/backgroundTask/completed")
    .map((row) => {
      const { item } = JSON.parse(row.data) as {
        item: { id: string; taskStatus: string };
      };
      return { itemId: item.id, taskStatus: item.taskStatus };
    });
}

async function stopRequest(
  harness: TestAppHarness,
  fixture: StopFixture,
  itemId: string,
): Promise<Response> {
  return harness.app.request(
    `/api/v1/threads/${fixture.threadId}/background-tasks/${itemId}/stop`,
    { method: "POST" },
  );
}

async function postEvents(
  harness: TestAppHarness,
  fixture: StopFixture,
  events: HostDaemonEventEnvelope[],
): Promise<void> {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId: fixture.sessionId,
      eventGroups: groupHostDaemonEvents(events),
    }),
  });
  expect(response.status).toBe(200);
}

describe("stopping a background task", () => {
  it("asks the host to stop a task of the current provider session", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaudeThread(harness);
      seedRunningCommand(
        harness,
        fixture,
        {
          itemId: "item-gc",
          taskId: "bslotgc1",
          providerThreadId: CURRENT_SESSION,
        },
        10,
      );
      const responder = registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: () => ({ ok: true, result: { stopped: true } }),
      });

      const response = await stopRequest(harness, fixture, "item-gc");

      expect(response.status).toBe(200);
      expect(responder.requests.map((request) => request.command)).toEqual([
        {
          type: "thread.backgroundTask.stop",
          environmentId: fixture.environmentId,
          threadId: fixture.threadId,
          itemId: "item-gc",
          taskId: "bslotgc1",
        },
      ]);
      expect(settledTasks(harness, fixture.threadId)).toEqual([]);
    });
  });

  it("settles the task itself when the provider no longer runs it", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaudeThread(harness);
      seedRunningCommand(
        harness,
        fixture,
        {
          itemId: "item-gc",
          taskId: "bslotgc1",
          providerThreadId: CURRENT_SESSION,
        },
        10,
      );
      registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: () => ({ ok: true, result: { stopped: false } }),
      });
      const notifyThread = vi.spyOn(harness.deps.hub, "notifyThread");

      const response = await stopRequest(harness, fixture, "item-gc");

      expect(response.status).toBe(200);
      expect(settledTasks(harness, fixture.threadId)).toEqual([
        { itemId: "item-gc", taskStatus: "stopped" },
      ]);
      expect(notifyThread).toHaveBeenCalledWith(
        fixture.threadId,
        ["events-appended"],
        {
          backgroundActivityChanged: true,
          eventTypes: ["item/backgroundTask/completed"],
          timelineSequence: 11,
        },
      );
    });
  });

  it("settles a task of an ended provider session without asking the host", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaudeThread(harness);
      seedRunningCommand(
        harness,
        fixture,
        { itemId: "item-old", taskId: "bold", providerThreadId: OLD_SESSION },
        10,
      );
      const responder = registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: () => ({ ok: true, result: { stopped: true } }),
      });

      const response = await stopRequest(harness, fixture, "item-old");

      expect(response.status).toBe(200);
      expect(responder.requests).toEqual([]);
      expect(settledTasks(harness, fixture.threadId)).toEqual([
        { itemId: "item-old", taskStatus: "stopped" },
      ]);
    });
  });

  it("keeps the task running and fails when the host cannot stop it", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaudeThread(harness);
      seedRunningCommand(
        harness,
        fixture,
        {
          itemId: "item-gc",
          taskId: "bslotgc1",
          providerThreadId: CURRENT_SESSION,
        },
        10,
      );
      registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: () => ({
          ok: false,
          errorCode: "command_failed",
          errorMessage: "no such task",
        }),
      });

      const response = await stopRequest(harness, fixture, "item-gc");

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(settledTasks(harness, fixture.threadId)).toEqual([]);
    });
  });

  it("refuses a provider that cannot stop background tasks", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaudeThread(harness, "codex");
      seedRunningCommand(
        harness,
        fixture,
        {
          itemId: "item-gc",
          taskId: "bslotgc1",
          providerThreadId: CURRENT_SESSION,
        },
        10,
      );

      const response = await stopRequest(harness, fixture, "item-gc");

      expect(response.status).toBe(409);
      expect(settledTasks(harness, fixture.threadId)).toEqual([]);
    });
  });

  it("answers ok for a task that already finished", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaudeThread(harness);

      const response = await stopRequest(harness, fixture, "item-gone");

      expect(response.status).toBe(200);
    });
  });
});

describe("reconciling background tasks with the provider session", () => {
  it("settles the tasks of an older session when the thread reports a new provider session", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaudeThread(harness);
      seedRunningCommand(
        harness,
        fixture,
        { itemId: "item-old", taskId: "bold", providerThreadId: OLD_SESSION },
        10,
      );
      seedRunningCommand(
        harness,
        fixture,
        {
          itemId: "item-new",
          taskId: "bnew",
          providerThreadId: "claude-session-next",
        },
        11,
      );

      await postEvents(harness, fixture, [
        {
          threadId: fixture.threadId,
          event: {
            type: "thread/identity",
            threadId: fixture.threadId,
            providerThreadId: "claude-session-next",
            scope: threadScope(),
          },
        },
      ]);

      expect(settledTasks(harness, fixture.threadId)).toEqual([
        { itemId: "item-old", taskStatus: "stopped" },
      ]);
    });
  });

  it("keeps a task that a later session in the same event batch started", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaudeThread(harness);
      seedTurnStarted(harness.deps, {
        environmentId: fixture.environmentId,
        providerThreadId: "claude-session-b",
        sequence: 5,
        threadId: fixture.threadId,
        turnId: "turn-b",
      });
      seedRunningCommand(
        harness,
        fixture,
        { itemId: "item-old", taskId: "bold", providerThreadId: OLD_SESSION },
        6,
      );

      await postEvents(harness, fixture, [
        {
          threadId: fixture.threadId,
          event: {
            type: "thread/identity",
            threadId: fixture.threadId,
            providerThreadId: "claude-session-a",
            scope: threadScope(),
          },
        },
        {
          threadId: fixture.threadId,
          event: {
            type: "thread/identity",
            threadId: fixture.threadId,
            providerThreadId: "claude-session-b",
            scope: threadScope(),
          },
        },
        {
          threadId: fixture.threadId,
          event: {
            type: "item/started",
            threadId: fixture.threadId,
            providerThreadId: "claude-session-b",
            scope: turnScope("turn-b"),
            item: {
              id: "item-b",
              type: "backgroundTask",
              familyId: "bnew",
              taskType: "local_bash",
              description: "Collect slots",
              status: "pending",
              taskStatus: "running",
              skipTranscript: false,
            },
          },
        },
      ]);

      expect(settledTasks(harness, fixture.threadId)).toEqual([
        { itemId: "item-old", taskStatus: "stopped" },
      ]);
    });
  });

  it("settles every task of a thread whose provider process exited", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedClaudeThread(harness);
      seedRunningCommand(
        harness,
        fixture,
        {
          itemId: "item-gc",
          taskId: "bslotgc1",
          providerThreadId: CURRENT_SESSION,
        },
        10,
      );

      await postEvents(harness, fixture, [
        {
          threadId: fixture.threadId,
          event: {
            type: "system/error",
            threadId: fixture.threadId,
            scope: threadScope(),
            code: "provider_process_exited",
            message: "Provider process exited",
          },
        },
      ]);

      expect(settledTasks(harness, fixture.threadId)).toEqual([
        { itemId: "item-gc", taskStatus: "stopped" },
      ]);
    });
  });
});
