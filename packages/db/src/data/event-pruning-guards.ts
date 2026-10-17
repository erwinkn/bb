import { sql } from "drizzle-orm";

export function isBeforeLatestThreadEvent(threadId: string) {
  return sql`events.sequence < (SELECT sequence FROM events WHERE thread_id = ${threadId} ORDER BY sequence DESC LIMIT 1)`;
}

export function isUnparentedEvent() {
  return sql`events.parent_tool_call_id IS NULL`;
}
