import type { ParentNoticesMode } from "@bb/domain";
import { parentNoticesModeSchema } from "@bb/server-contract";

export const PARENT_NOTICES_HELP =
  "Whether this thread's turn ends notify its parent: turns (default; every turn end) or explicit (final reports only: the parent hears only the messages this thread sends it and its needs-input notices)";
export const FINAL_REPORTS_ONLY_HELP =
  "Final reports only: same as --parent-notices explicit";

export function resolveParentNoticesOption(args: {
  finalReportsOnly?: boolean;
  parentNotices?: string;
}): ParentNoticesMode | undefined {
  const parsed =
    args.parentNotices === undefined
      ? undefined
      : parentNoticesModeSchema.safeParse(args.parentNotices);
  if (parsed !== undefined && !parsed.success) {
    throw new Error("--parent-notices must be turns or explicit.");
  }
  if (args.finalReportsOnly && parsed?.data === "turns") {
    throw new Error(
      "Cannot combine --final-reports-only with --parent-notices turns.",
    );
  }
  return args.finalReportsOnly ? "explicit" : parsed?.data;
}

export function describeParentNotices(mode: ParentNoticesMode): string {
  return mode === "explicit"
    ? "final reports only (explicit)"
    : "every turn end (turns)";
}
