import { describe, expect, it } from "vitest";
import {
  createConnection,
  deleteThreadEventSuffixInTransaction,
  getLatestStoredConversationOutlineSequence,
  getLatestThreadSequence,
  listThreadTimelineCheckpointParts,
  type DbConnection,
} from "@bb/db";
import type { Thread } from "@bb/domain";
import { getTimelineGroupingContext } from "../../../src/services/threads/timeline-context-order.js";
import {
  buildThreadConversationOutline,
  loadThreadConversationOutlineWithSource,
} from "../../../src/services/threads/timeline.js";
import {
  appendRows,
  withTestThread,
  type RowSpec,
  type TestThread,
} from "../../helpers/timeline-cache-fixture.js";

function turn(index: number): RowSpec[] {
  const requestId = `creq_${index.toString(8).replaceAll("0", "a").replaceAll("1", "b").padStart(10, "a")}`;
  const turnId = `turn-${index}`;
  const itemId = `message-${index}`;
  return [
    {
      type: "client/turn/requested",
      data: {
        direction: "outbound",
        requestId,
        source: "tell",
        initiator: "user",
        senderThreadId: null,
        input: [{ type: "text", text: `Question ${index}` }],
        target: { kind: "new-turn" },
        request: { method: "turn/start", params: {} },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "workspace-write",
          source: "client/turn/requested",
          serviceTier: "auto",
        },
      },
    },
    { type: "turn/started", turnId },
    {
      type: "turn/input/accepted",
      turnId,
      data: { clientRequestId: requestId },
    },
    {
      type: "item/completed",
      turnId,
      itemId,
      itemKind: "agentMessage",
      data: {
        item: { id: itemId, type: "agentMessage", text: `Answer ${index}` },
      },
    },
    { type: "turn/completed", turnId, data: { status: "completed" } },
  ];
}

function seed(testThread: TestThread, from: number, count: number): void {
  appendRows(
    testThread,
    Array.from({ length: count }, (_, index) => turn(from + index)).flat(),
  );
}

function outlineOptions(db: DbConnection, threadId: string) {
  return {
    completedTurnDisplay: "collapse" as const,
    includeClearedContextHistory: false,
    maxSeq: getLatestThreadSequence(db, { threadId }),
    outlineSequence: getLatestStoredConversationOutlineSequence(db, {
      threadId,
    }),
  };
}

function load(db: DbConnection, thread: Thread) {
  return loadThreadConversationOutlineWithSource(
    db,
    thread,
    outlineOptions(db, thread.id),
  );
}

function fullOutline(testThread: TestThread, thread = testThread.thread) {
  return buildThreadConversationOutline(
    testThread.coldDb,
    thread,
    outlineOptions(testThread.coldDb, thread.id),
  );
}

function restart(testThread: TestThread): DbConnection {
  return createConnection(testThread.db.$client.name);
}

function countRowsRead(
  db: DbConnection,
  matches: (source: string) => boolean,
  run: () => void,
): number {
  const raw = db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  let count = 0;
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);
      if (!matches(source)) return statement;
      const all = statement.all.bind(statement);
      return Object.assign(statement, {
        all: (...params: unknown[]) => {
          const rows = all(...params);
          count += rows.length;
          return rows;
        },
      });
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(raw, "prepare", {
      configurable: true,
      writable: true,
      value: originalPrepare,
    });
  }
  return count;
}

const outlineEventQuery = (source: string) =>
  source.includes('from "events"') && source.includes('"created_at"');
const orderingQuery = (source: string) =>
  source.includes("'$.clientRequestId'");

function parts(db: DbConnection, threadId: string, kind: string) {
  return listThreadTimelineCheckpointParts(db, { kind, threadId });
}

describe("persisted timeline checkpoints", () => {
  it("continues the outline after a restart from the persisted checkpoint instead of rebuilding it", () => {
    withTestThread((testThread) => {
      seed(testThread, 0, 100);
      expect(load(testThread.db, testThread.thread).source).toBe("full");
      seed(testThread, 100, 2);

      const restarted = restart(testThread);
      try {
        let result: ReturnType<typeof load> | undefined;
        const rowsRead = countRowsRead(restarted, outlineEventQuery, () => {
          result = load(restarted, testThread.thread);
        });
        expect(result?.source).toBe("persisted");
        expect(rowsRead).toBeLessThan(30);
        expect(result?.response).toEqual(fullOutline(testThread));
      } finally {
        restarted.$client.close();
      }
    });
  });

  it("drops the persisted checkpoint and stored outline when history is rewritten", () => {
    withTestThread((testThread) => {
      const idle: Thread = { ...testThread.thread, status: "idle" };
      seed(testThread, 0, 20);
      load(testThread.db, testThread.thread);
      load(testThread.db, idle);
      expect(
        parts(testThread.db, idle.id, "conversation-outline").length,
      ).toBeGreaterThan(0);
      const maxSeq = getLatestThreadSequence(testThread.db, {
        threadId: idle.id,
      });
      testThread.db.transaction((tx) =>
        deleteThreadEventSuffixInTransaction(tx, {
          cutoffSequence: maxSeq - 6,
          oldMaxSequence: maxSeq,
          threadId: idle.id,
        }),
      );
      expect(parts(testThread.db, idle.id, "conversation-outline")).toEqual([]);

      const restarted = restart(testThread);
      try {
        const result = load(restarted, idle);
        expect(result.source).toBe("full");
        expect(result.response).toEqual(fullOutline(testThread, idle));
      } finally {
        restarted.$client.close();
      }
    });
  });

  it("serves an idle thread's stored outline after a restart", () => {
    withTestThread((testThread) => {
      const idle: Thread = { ...testThread.thread, status: "idle" };
      seed(testThread, 0, 5);
      expect(load(testThread.db, idle).source).toBe("full");
      const restarted = restart(testThread);
      try {
        const result = load(restarted, idle);
        expect(result.source).toBe("stored");
        expect(result.response).toEqual(fullOutline(testThread, idle));
      } finally {
        restarted.$client.close();
      }
    });
  });

  it("keeps a long-lived thread's chain bounded by merging its parts", () => {
    withTestThread((testThread) => {
      const threadId = testThread.thread.id;
      seed(testThread, 0, 3);
      const kinds = ["conversation-outline", "timeline-ordering-rows:0"];
      const previous = new Map<string, number>();
      const merges = new Set<string>();
      let maxParts = 0;
      for (let index = 3; index < 150; index += 1) {
        seed(testThread, index, 1);
        load(testThread.db, testThread.thread);
        getTimelineGroupingContext(testThread.db, {
          maxSeq: getLatestThreadSequence(testThread.db, { threadId }),
          sequenceStart: 0,
          threadId,
        });
        for (const kind of kinds) {
          const count = parts(testThread.db, threadId, kind).length;
          if (count < (previous.get(kind) ?? 0)) merges.add(kind);
          previous.set(kind, count);
          maxParts = Math.max(maxParts, count);
        }
      }
      expect([...merges].sort()).toEqual(kinds);
      expect(maxParts).toBeLessThanOrEqual(64);
      const restarted = restart(testThread);
      try {
        const result = load(restarted, testThread.thread);
        expect(result.source).toBe("persisted");
        expect(result.response).toEqual(fullOutline(testThread));
      } finally {
        restarted.$client.close();
      }
    });
  });

  it("rebuilds when the persisted checkpoint cannot be read", () => {
    withTestThread((testThread) => {
      seed(testThread, 0, 20);
      load(testThread.db, testThread.thread);
      testThread.db.$client
        .prepare(
          "UPDATE thread_timeline_checkpoints SET payload = '{' WHERE kind = 'conversation-outline'",
        )
        .run();
      const restarted = restart(testThread);
      try {
        const result = load(restarted, testThread.thread);
        expect(result.source).toBe("full");
        expect(result.response).toEqual(fullOutline(testThread));
      } finally {
        restarted.$client.close();
      }
    });
  });

  it("reads only the ordering rows appended since the persisted ones after a restart", () => {
    withTestThread((testThread) => {
      const threadId = testThread.thread.id;
      seed(testThread, 0, 30);
      const args = () => ({
        maxSeq: getLatestThreadSequence(testThread.db, { threadId }),
        sequenceStart: 0,
        threadId,
      });
      getTimelineGroupingContext(testThread.db, args());
      seed(testThread, 30, 1);

      const restarted = restart(testThread);
      const cold = restart(testThread);
      try {
        let warm: ReturnType<typeof getTimelineGroupingContext> | undefined;
        const rowsRead = countRowsRead(restarted, orderingQuery, () => {
          warm = getTimelineGroupingContext(restarted, args());
        });
        expect(rowsRead).toBe(4);
        testThread.db.$client
          .prepare("DELETE FROM thread_timeline_checkpoints")
          .run();
        let reference:
          | ReturnType<typeof getTimelineGroupingContext>
          | undefined;
        expect(
          countRowsRead(cold, orderingQuery, () => {
            reference = getTimelineGroupingContext(cold, args());
          }),
        ).toBe(31 * 4);
        expect(warm).toEqual(reference);
      } finally {
        cold.$client.close();
        restarted.$client.close();
      }
    });
  });

  it("keeps a separate ordering chain per history start, so alternating starts both survive a restart", () => {
    withTestThread((testThread) => {
      const threadId = testThread.thread.id;
      seed(testThread, 0, 10);
      const laterStart =
        getLatestThreadSequence(testThread.db, { threadId }) + 1;
      const args = (sequenceStart: number) => ({
        maxSeq: getLatestThreadSequence(testThread.db, { threadId }),
        sequenceStart,
        threadId,
      });
      for (let index = 10; index < 14; index += 1) {
        seed(testThread, index, 1);
        getTimelineGroupingContext(testThread.db, args(0));
        getTimelineGroupingContext(testThread.db, args(laterStart));
      }
      seed(testThread, 14, 1);

      const restarted = restart(testThread);
      try {
        for (const sequenceStart of [0, laterStart])
          expect(
            countRowsRead(restarted, orderingQuery, () => {
              getTimelineGroupingContext(restarted, args(sequenceStart));
            }),
          ).toBe(4);
      } finally {
        restarted.$client.close();
      }
    });
  });

  it("ignores persisted ordering rows written for a different query", () => {
    withTestThread((testThread) => {
      const threadId = testThread.thread.id;
      seed(testThread, 0, 10);
      const args = {
        maxSeq: getLatestThreadSequence(testThread.db, { threadId }),
        sequenceStart: 0,
        threadId,
      };
      getTimelineGroupingContext(testThread.db, args);
      testThread.db.$client
        .prepare(
          "UPDATE thread_timeline_checkpoints SET payload = json_set(payload, '$.query', 'older') WHERE kind = 'timeline-ordering-rows:0'",
        )
        .run();
      const restarted = restart(testThread);
      try {
        expect(
          countRowsRead(restarted, orderingQuery, () => {
            getTimelineGroupingContext(restarted, args);
          }),
        ).toBe(10 * 4);
      } finally {
        restarted.$client.close();
      }
    });
  });
});
