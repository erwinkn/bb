import { listQueuedThreadMessages, type DbConnection } from "@bb/db";
import type { Thread } from "@bb/domain";
import { loadFailedTurn, wasFailedTurnInputAccepted } from "./turn-failed.js";

export const ERRORED_THREAD_QUEUE_GRACE_MS = 60_000;

export function isErroredThreadQueueDrainable(
  db: DbConnection,
  args: { now: number; thread: Thread },
): boolean {
  const { thread } = args;
  if (thread.status !== "error") return false;
  if (args.now - thread.updatedAt < ERRORED_THREAD_QUEUE_GRACE_MS) return false;
  if (
    listQueuedThreadMessages(db, thread.id).some(
      (row) => row.payloadKind === "retry",
    )
  ) {
    return false;
  }
  const failed = loadFailedTurn(db, thread.id);
  return (
    failed !== null &&
    wasFailedTurnInputAccepted(db, { threadId: thread.id, failed })
  );
}
