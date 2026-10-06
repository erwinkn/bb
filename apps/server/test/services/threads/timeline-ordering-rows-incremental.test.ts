import { describe, expect, it } from "vitest";
import {
  clearTimelineOrderingContextCache,
  getTimelineGroupingContext,
} from "../../../src/services/threads/timeline-context-order.js";
import {
  appendRows,
  withTestThread,
  type RowSpec,
  type TestThread,
} from "../../helpers/timeline-cache-fixture.js";

function turn(index: number): RowSpec[] {
  const requestId = `request-${index}`;
  const turnId = `turn-${index}`;
  return [
    {
      data: {
        initiator: "user",
        input: [{ text: `message ${index}`, type: "text" }],
        requestId,
        target: { kind: "new-turn" },
      },
      type: "client/turn/requested",
    },
    {
      data: { clientRequestId: requestId },
      turnId,
      type: "turn/input/accepted",
    },
    { turnId, type: "turn/started" },
    { data: { status: "completed" }, turnId, type: "turn/completed" },
  ];
}

function countOrderingRowsRead(db: TestThread["db"], run: () => void): number {
  let rowsRead = 0;
  const raw = db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);
      if (!source.includes("'$.clientRequestId'")) return statement;
      const all = statement.all.bind(statement);
      return Object.assign(statement, {
        all: (...params: unknown[]) => {
          const rows = all(...params);
          rowsRead += rows.length;
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
  return rowsRead;
}

describe("timeline ordering rows", () => {
  it("reads only the rows appended since the last build, and matches a cold build", () => {
    withTestThread((testThread) => {
      const threadId = testThread.thread.id;
      let maxSeq = 0;
      for (let index = 1; index <= 30; index += 1) {
        maxSeq = appendRows(testThread, turn(index));
      }
      getTimelineGroupingContext(testThread.db, {
        maxSeq,
        sequenceStart: 0,
        threadId,
      });

      maxSeq = appendRows(testThread, turn(31));
      let warm: ReturnType<typeof getTimelineGroupingContext> | undefined;
      const rowsRead = countOrderingRowsRead(testThread.db, () => {
        warm = getTimelineGroupingContext(testThread.db, {
          maxSeq,
          sequenceStart: 0,
          threadId,
        });
      });

      expect(rowsRead).toBe(4);
      clearTimelineOrderingContextCache(testThread.coldDb);
      expect(warm).toEqual(
        getTimelineGroupingContext(testThread.coldDb, {
          maxSeq,
          sequenceStart: 0,
          threadId,
        }),
      );
    });
  });
});
