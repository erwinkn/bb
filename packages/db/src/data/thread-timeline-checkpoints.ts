import { and, asc, count, eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  threadConversationOutlines,
  threadTimelineCheckpoints,
} from "../schema.js";

export interface ThreadTimelineCheckpointPartKey {
  kind: string;
  threadId: string;
}

export function listThreadTimelineCheckpointParts(
  db: DbConnection,
  key: ThreadTimelineCheckpointPartKey,
): { part: number; payload: string }[] {
  return db
    .select({
      part: threadTimelineCheckpoints.part,
      payload: threadTimelineCheckpoints.payload,
    })
    .from(threadTimelineCheckpoints)
    .where(
      and(
        eq(threadTimelineCheckpoints.threadId, key.threadId),
        eq(threadTimelineCheckpoints.kind, key.kind),
      ),
    )
    .orderBy(asc(threadTimelineCheckpoints.part))
    .all();
}

export function appendThreadTimelineCheckpointPart(
  db: DbConnection,
  args: ThreadTimelineCheckpointPartKey & { part: number; payload: string },
): boolean {
  return db.transaction((tx) => {
    const stored = tx
      .select({ parts: count() })
      .from(threadTimelineCheckpoints)
      .where(
        and(
          eq(threadTimelineCheckpoints.threadId, args.threadId),
          eq(threadTimelineCheckpoints.kind, args.kind),
        ),
      )
      .get();
    if (stored?.parts !== args.part) return false;
    return (
      tx
        .insert(threadTimelineCheckpoints)
        .values(args)
        .onConflictDoNothing()
        .run().changes === 1
    );
  });
}

export function replaceThreadTimelineCheckpoint(
  db: DbConnection,
  args: ThreadTimelineCheckpointPartKey & { payload: string | null },
): void {
  db.transaction((tx) => {
    tx.delete(threadTimelineCheckpoints)
      .where(
        and(
          eq(threadTimelineCheckpoints.threadId, args.threadId),
          eq(threadTimelineCheckpoints.kind, args.kind),
        ),
      )
      .run();
    if (args.payload !== null)
      tx.insert(threadTimelineCheckpoints)
        .values({
          kind: args.kind,
          part: 0,
          payload: args.payload,
          threadId: args.threadId,
        })
        .run();
  });
}

export function deletePersistedThreadTimelineState(
  db: DbQueryConnection,
  threadId: string,
): void {
  db.delete(threadTimelineCheckpoints)
    .where(eq(threadTimelineCheckpoints.threadId, threadId))
    .run();
  db.delete(threadConversationOutlines)
    .where(eq(threadConversationOutlines.threadId, threadId))
    .run();
}
