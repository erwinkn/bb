import type { ParentNoticesMode } from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  getThreadPluginMetadata,
  patchThreadPluginMetadata,
} from "./thread-plugin-metadata.js";

export const PARENT_NOTICES_METADATA_NAMESPACE = "bb:parent-notices";

export function getThreadParentNoticesMode(
  db: DbQueryConnection,
  threadId: string,
): ParentNoticesMode {
  return getThreadPluginMetadata(
    db,
    threadId,
    PARENT_NOTICES_METADATA_NAMESPACE,
  ).metadata.mode === "explicit"
    ? "explicit"
    : "turns";
}

export function setThreadParentNoticesMode(
  db: DbConnection,
  args: { threadId: string; mode: ParentNoticesMode },
): void {
  patchThreadPluginMetadata(db, {
    threadId: args.threadId,
    pluginId: PARENT_NOTICES_METADATA_NAMESPACE,
    set: args.mode === "turns" ? {} : { mode: args.mode },
    remove: args.mode === "turns" ? ["mode"] : [],
  });
}
