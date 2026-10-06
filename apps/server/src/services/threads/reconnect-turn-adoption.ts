import { and, desc, eq, isNull } from "drizzle-orm";
import {
  deleteQueuedRetriesForThreadEventSuffixInTransaction,
  deleteThreadEventSuffixInTransaction,
  events,
  getActiveStoredTurnId,
  getLastStoredTurnRequestEvent,
  type DbQueryConnection,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";

export type ReportedLiveThreadRevival = "revive" | "adopt" | "leave";

interface OwnInterruptionTail {
  cutoffSequence: number;
  oldMaxSequence: number;
  turnId: string;
}

class TurnStillClosedError extends Error {}

function getLatestRootTurnStarted(
  db: DbQueryConnection,
  threadId: string,
): { sequence: number; turnId: string } | null {
  const row = db
    .select({ sequence: events.sequence, turnId: events.turnId })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "turn/started"),
        isNull(events.parentToolCallId),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  return row?.turnId ? { sequence: row.sequence, turnId: row.turnId } : null;
}

function parseData(data: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(data);
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

function findOwnInterruptionTail(
  db: DbQueryConnection,
  args: { threadId: string; turnId: string },
): OwnInterruptionTail | null {
  const tail = db
    .select({
      data: events.data,
      sequence: events.sequence,
      turnId: events.turnId,
      type: events.type,
    })
    .from(events)
    .where(eq(events.threadId, args.threadId))
    .orderBy(desc(events.sequence))
    .limit(3)
    .all()
    .reverse();
  const interrupted = tail.at(-1);
  if (
    interrupted?.type !== "system/thread/interrupted" ||
    parseData(interrupted.data).reason !== "host-daemon-restarted"
  ) {
    return null;
  }
  const completedIndex = tail.findIndex((row) => row.type === "turn/completed");
  const completed = tail[completedIndex];
  if (
    completed === undefined ||
    completed.turnId !== args.turnId ||
    parseData(completed.data).status !== "interrupted"
  ) {
    return null;
  }
  const between = tail.slice(completedIndex + 1, -1);
  if (
    !between.every(
      (row) =>
        row.type === "system/error" &&
        row.turnId === args.turnId &&
        parseData(row.data).code === "thread_command_failed",
    )
  ) {
    return null;
  }
  return {
    cutoffSequence: completed.sequence,
    oldMaxSequence: interrupted.sequence,
    turnId: args.turnId,
  };
}

export function resolveReportedLiveThreadRevival(
  db: DbQueryConnection,
  args: { sameDaemonInstance: boolean; threadId: string },
): ReportedLiveThreadRevival {
  if (getActiveStoredTurnId(db, args.threadId) !== null) {
    return "revive";
  }
  const latestTurn = getLatestRootTurnStarted(db, args.threadId);
  const latestRequest = getLastStoredTurnRequestEvent(db, args.threadId);
  if (
    latestRequest !== null &&
    (latestTurn === null || latestRequest.sequence > latestTurn.sequence)
  ) {
    return "revive";
  }
  if (
    args.sameDaemonInstance &&
    latestTurn !== null &&
    findOwnInterruptionTail(db, {
      threadId: args.threadId,
      turnId: latestTurn.turnId,
    }) !== null
  ) {
    return "adopt";
  }
  return "leave";
}

export function adoptReportedLiveTurn(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { threadId: string },
): boolean {
  let cancelledRetryCount = 0;
  let adoptedTurnId: string;
  try {
    adoptedTurnId = deps.db.transaction(
      (tx) => {
        const latestTurn = getLatestRootTurnStarted(tx, args.threadId);
        const tail =
          latestTurn === null
            ? null
            : findOwnInterruptionTail(tx, {
                threadId: args.threadId,
                turnId: latestTurn.turnId,
              });
        if (tail === null) {
          throw new TurnStillClosedError();
        }
        cancelledRetryCount =
          deleteQueuedRetriesForThreadEventSuffixInTransaction(tx, {
            cutoffSequence:
              getLastStoredTurnRequestEvent(tx, args.threadId)?.sequence ??
              tail.cutoffSequence,
            oldMaxSequence: tail.oldMaxSequence,
            threadId: args.threadId,
          });
        deleteThreadEventSuffixInTransaction(tx, {
          cutoffSequence: tail.cutoffSequence,
          oldMaxSequence: tail.oldMaxSequence,
          threadId: args.threadId,
        });
        if (getActiveStoredTurnId(tx, args.threadId) !== tail.turnId) {
          throw new TurnStillClosedError();
        }
        return tail.turnId;
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (error instanceof TurnStillClosedError) {
      return false;
    }
    throw error;
  }

  deps.logger.info(
    { threadId: args.threadId, turnId: adoptedTurnId, cancelledRetryCount },
    "Re-adopted a running turn the daemon still reports after reconnecting",
  );
  applyLoggedThreadLifecycleEvent(deps, {
    event: { type: "run.started" },
    threadId: args.threadId,
  });
  deps.hub.notifyThread(args.threadId, [
    "history-rewritten",
    ...(cancelledRetryCount > 0 ? ["queue-changed" as const] : []),
  ]);
  return true;
}

export function reviveReportedLiveThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { sameDaemonInstance: boolean; threadId: string },
): boolean {
  switch (resolveReportedLiveThreadRevival(deps.db, args)) {
    case "revive":
      applyLoggedThreadLifecycleEvent(deps, {
        event: { type: "run.started" },
        threadId: args.threadId,
      });
      return true;
    case "adopt":
      return adoptReportedLiveTurn(deps, args);
    case "leave":
      deps.logger.info(
        { threadId: args.threadId },
        "Left a thread settled: the daemon reports it live but it has no turn to resume",
      );
      return false;
  }
}
