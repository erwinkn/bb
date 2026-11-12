import type { ParentNoticesMode } from "@bb/domain";

export function describeParentNotices(mode: ParentNoticesMode): string {
  return mode === "explicit"
    ? "final reports only (explicit)"
    : "every turn end (turns)";
}
