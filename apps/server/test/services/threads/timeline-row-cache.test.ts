import { describe, expect, it } from "vitest";
import type { ThreadEventItemType, ThreadEventType } from "@bb/domain";
import {
  deleteThreadEventSuffixInTransaction,
  getLatestThreadSequence,
} from "@bb/db";
import { clearTimelineOrderingContextCache } from "../../../src/services/threads/timeline-context-order.js";
import type { ThreadTimelinePageRequest } from "../../../src/services/threads/timeline-pagination.js";
import {
  cachedTimelineRowSource,
  clearTimelineRowCache,
  readTimelineRowCacheSize,
} from "../../../src/services/threads/timeline-row-cache.js";
import { THREAD_TIMELINE_EXCLUDED_EVENT_TYPES } from "@bb/thread-view";
import { createTestProviderRegistry } from "../../helpers/provider-registry.js";
import {
  appendRows as append,
  createRandom,
  PROVIDER_THREAD_ID as providerThreadId,
  withTestThread,
  type Random,
  type RowSpec,
  type TestThread,
} from "../../helpers/timeline-cache-fixture.js";
import {
  buildRouteTimelinePage,
  clearCrossBuildTimelineCaches,
  type BuiltTimelinePage,
  type TimelineVariant,
} from "../../provider-corpus/corpus-harness.js";

const registry = await createTestProviderRegistry();

interface BuildArgs {
  maxSeq?: number;
  page: ThreadTimelinePageRequest;
  variant: TimelineVariant;
}

const latest: BuildArgs = {
  page: { kind: "latest", segmentLimit: 3 },
  variant: "default",
};

function build(
  testThread: TestThread,
  db: TestThread["db"],
  args: BuildArgs,
): BuiltTimelinePage {
  return buildRouteTimelinePage({
    ...args,
    db,
    eventBudget: 20,
    includeDiagnosticOperations: false,
    registry,
    thread: testThread.thread,
  });
}

function expectWarmEqualsCold(
  testThread: TestThread,
  args: BuildArgs,
  label: string,
): BuiltTimelinePage {
  const warm = build(testThread, testThread.db, args);
  clearCrossBuildTimelineCaches(testThread.coldDb);
  clearTimelineOrderingContextCache(testThread.coldDb);
  const cold = build(testThread, testThread.coldDb, args);
  expect(JSON.stringify(warm.response), label).toBe(
    JSON.stringify(cold.response),
  );
  const selected = ({ profile }: BuiltTimelinePage) => ({
    eventDataBytes: profile.eventDataBytes,
    eventRowCount: profile.eventRowCount,
  });
  expect(selected(warm), label).toEqual(selected(cold));
  return warm;
}

function itemRow(
  type: ThreadEventType,
  turnId: string | null,
  item: Record<string, unknown> & { id: string; type: ThreadEventItemType },
  parentToolCallId: string | null = null,
): RowSpec {
  return {
    data: {
      providerThreadId,
      item: parentToolCallId === null ? item : { ...item, parentToolCallId },
    },
    itemId: item.id,
    itemKind: item.type,
    parentToolCallId,
    providerThreadId,
    turnId,
    type,
  };
}

function delegation(turnId: string, id: string, completed: boolean): RowSpec {
  return itemRow(
    completed ? "item/delegation/completed" : "item/started",
    completed ? null : turnId,
    {
      background: true,
      childRef: `child-${id}`,
      id,
      label: `Subagent ${id}`,
      status: completed ? "completed" : "pending",
      type: "delegation",
      ...(completed ? { summary: "launched" } : {}),
    },
  );
}

function task(
  type:
    | "item/started"
    | "item/backgroundTask/progress"
    | "item/backgroundTask/completed",
  turnId: string,
  taskId: string,
  delegationId: string,
  tokens: number,
): RowSpec {
  const done = type === "item/backgroundTask/completed";
  return itemRow(
    type,
    type === "item/started" ? turnId : null,
    {
      description: `Task ${taskId}`,
      id: taskId,
      skipTranscript: false,
      status: done ? "completed" : "pending",
      taskStatus: done ? "completed" : "running",
      taskType: "local_agent",
      type: "backgroundTask",
      usage: { durationMs: tokens, toolUses: tokens, totalTokens: tokens },
    },
    delegationId,
  );
}

function command(
  turnId: string,
  id: string,
  completed: boolean,
  parentToolCallId: string | null = null,
): RowSpec {
  return itemRow(
    completed ? "item/completed" : "item/started",
    turnId,
    {
      aggregatedOutput: completed ? `output ${id}\n` : "",
      approvalStatus: null,
      command: `rg --files src/${id}`,
      cwd: "/tmp/memo",
      ...(completed ? { exitCode: 0 } : {}),
      id,
      status: completed ? "completed" : "pending",
      type: "commandExecution",
    },
    parentToolCallId,
  );
}

function fileChange(turnId: string, id: string, completed: boolean): RowSpec {
  return itemRow(completed ? "item/completed" : "item/started", turnId, {
    approvalStatus: null,
    changes: [
      {
        diff: `--- a/${id}.ts\n+++ b/${id}.ts\n@@ -1 +1 @@\n-old\n+new\n`,
        kind: "update",
        path: `/tmp/memo/${id}.ts`,
      },
    ],
    id,
    status: completed ? "completed" : "pending",
    type: "fileChange",
  });
}

interface Session {
  counter: number;
  delegations: string[];
  openCommands: string[];
  openFileChanges: string[];
  tasks: { delegationId: string; done: boolean; id: string }[];
  turnId: string | null;
  turns: number;
}

function newSession(): Session {
  return {
    counter: 0,
    delegations: [],
    openCommands: [],
    openFileChanges: [],
    tasks: [],
    turnId: null,
    turns: 0,
  };
}

function nextId(session: Session, prefix: string): string {
  session.counter += 1;
  return `${prefix}-${session.counter}`;
}

function pickFrom<T>(random: Random, values: readonly T[]): T | undefined {
  return values[Math.floor(random() * values.length)];
}

function randomRows(session: Session, random: Random): RowSpec[] {
  const turnId = session.turnId;
  const runningTasks = session.tasks.filter((entry) => !entry.done);
  const running = pickFrom(random, runningTasks);
  const roll = random();
  if (running !== undefined && roll < 0.3) {
    const completed = random() < 0.15;
    running.done = completed;
    return [
      task(
        completed
          ? "item/backgroundTask/completed"
          : "item/backgroundTask/progress",
        "unused",
        running.id,
        running.delegationId,
        session.counter++,
      ),
    ];
  }
  if (turnId === null) {
    session.turns += 1;
    session.turnId = `turn-${session.turns}`;
    return [{ data: {}, turnId: session.turnId, type: "turn/started" }];
  }
  if (roll < 0.4) {
    const id = nextId(session, "delegation");
    const taskId = nextId(session, "task");
    session.delegations.push(id);
    session.tasks.push({ delegationId: id, done: false, id: taskId });
    return [
      delegation(turnId, id, false),
      delegation(turnId, id, true),
      task("item/started", turnId, taskId, id, 0),
    ];
  }
  if (roll < 0.5) {
    const parent = pickFrom(random, session.delegations);
    if (parent !== undefined) {
      const id = nextId(session, "child");
      return [
        command(turnId, id, false, parent),
        command(turnId, id, true, parent),
      ];
    }
  }
  if (roll < 0.65) {
    const open = session.openCommands.pop();
    if (open !== undefined) return [command(turnId, open, true)];
    const id = nextId(session, "command");
    session.openCommands.push(id);
    return [command(turnId, id, false)];
  }
  if (roll < 0.8) {
    const open = session.openFileChanges.pop();
    if (open !== undefined) return [fileChange(turnId, open, true)];
    const id = nextId(session, "edit");
    session.openFileChanges.push(id);
    return [fileChange(turnId, id, false)];
  }
  if (roll < 0.9) {
    const itemId = nextId(session, "message");
    return [
      {
        data: { delta: "word ", itemId },
        itemId,
        turnId,
        type: "item/agentMessage/delta",
      },
    ];
  }
  session.turnId = null;
  session.openCommands = [];
  session.openFileChanges = [];
  return [{ data: { status: "completed" }, turnId, type: "turn/completed" }];
}

describe("timeline row cache", () => {
  it("matches a cold build while subagent progress rows supersede cached ones", () => {
    let maxGroups = 0;
    for (let seed = 1; seed <= 6; seed += 1) {
      const random = createRandom(seed);
      withTestThread((testThread) => {
        const session = newSession();
        for (let step = 0; step < 90; step += 1) {
          append(testThread, randomRows(session, random));
          const label = JSON.stringify({ seed, step });
          expectWarmEqualsCold(testThread, latest, label);
          expectWarmEqualsCold(
            testThread,
            { ...latest, variant: "nested" },
            `${label} nested`,
          );
          maxGroups = Math.max(
            maxGroups,
            readTimelineRowCacheSize(testThread.db).groupCount,
          );
          if (step % 15 === 14) {
            const maxSeq = getLatestThreadSequence(testThread.db, {
              threadId: testThread.thread.id,
            });
            expectWarmEqualsCold(
              testThread,
              { ...latest, maxSeq: Math.max(1, maxSeq - 7) },
              `${label} past`,
            );
          }
        }
      });
    }
    expect(maxGroups).toBeGreaterThan(3);
  }, 120_000);

  it("keeps only the newest progress row of a subagent task", () => {
    withTestThread((testThread) => {
      const threadId = testThread.thread.id;
      append(testThread, [
        { data: {}, turnId: "turn-1", type: "turn/started" },
        delegation("turn-1", "delegation-1", false),
        task("item/started", "turn-1", "task-1", "delegation-1", 0),
        task(
          "item/backgroundTask/progress",
          "turn-1",
          "task-1",
          "delegation-1",
          1,
        ),
      ]);
      const query = (beforeSequence: number) =>
        cachedTimelineRowSource
          .listParentedRows(testThread.db, {
            beforeSequence,
            excludeDiagnosticEvents: true,
            excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
            maxInlineOutputChars: 1_000,
            parentToolCallIds: ["delegation-1"],
            sequenceStart: 0,
            threadId,
          })
          .map((row) => `${row.sequence}:${row.type}`);
      const at = () => getLatestThreadSequence(testThread.db, { threadId }) + 1;
      expect(query(at())).toEqual([
        "3:item/started",
        "4:item/backgroundTask/progress",
      ]);
      append(testThread, [
        task(
          "item/backgroundTask/progress",
          "turn-1",
          "task-1",
          "delegation-1",
          2,
        ),
        command("turn-1", "child-1", true, "delegation-1"),
      ]);
      expect(query(at())).toEqual([
        "3:item/started",
        "5:item/backgroundTask/progress",
        "6:item/completed",
      ]);
      expect(query(5)).toEqual([
        "3:item/started",
        "4:item/backgroundTask/progress",
      ]);
      append(testThread, [
        task(
          "item/backgroundTask/completed",
          "turn-1",
          "task-1",
          "delegation-1",
          3,
        ),
      ]);
      expect(query(at())).toEqual([
        "3:item/started",
        "6:item/completed",
        "7:item/backgroundTask/completed",
      ]);
      clearTimelineRowCache(testThread.db);
      expect(query(at())).toEqual([
        "3:item/started",
        "6:item/completed",
        "7:item/backgroundTask/completed",
      ]);
    });
  });

  it("drops cached rows when history is rewritten", () => {
    withTestThread((testThread) => {
      const threadId = testThread.thread.id;
      append(testThread, [
        { data: {}, turnId: "turn-1", type: "turn/started" },
        command("turn-1", "command-1", false),
        command("turn-1", "command-1", true),
        fileChange("turn-1", "edit-1", false),
      ]);
      expectWarmEqualsCold(testThread, latest, "before rewrite");
      const latestSequence = getLatestThreadSequence(testThread.db, {
        threadId,
      });
      testThread.db.transaction((tx) => {
        deleteThreadEventSuffixInTransaction(tx, {
          cutoffSequence: latestSequence - 1,
          oldMaxSequence: latestSequence,
          threadId,
        });
      });
      append(testThread, [
        fileChange("turn-1", "edit-2", false),
        fileChange("turn-1", "edit-2", true),
      ]);
      expect(getLatestThreadSequence(testThread.db, { threadId })).toBe(
        latestSequence,
      );
      expectWarmEqualsCold(testThread, latest, "after rewrite");
    });
  });

  it("leaves rows of threads that are not running out of the cache", () => {
    withTestThread((testThread) => {
      append(testThread, [
        { data: {}, turnId: "turn-1", type: "turn/started" },
        command("turn-1", "command-1", true),
      ]);
      expectWarmEqualsCold(testThread, latest, "active");
      expect(readTimelineRowCacheSize(testThread.db).groupCount).toBe(1);
      const idle = { ...testThread.thread, status: "idle" as const };
      expectWarmEqualsCold({ ...testThread, thread: idle }, latest, "idle");
      expect(readTimelineRowCacheSize(testThread.db).groupCount).toBe(0);
    });
  });
});
