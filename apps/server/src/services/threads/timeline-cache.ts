import type { ThreadTimelineResponse } from "@bb/server-contract";
import type { ThreadStatus } from "@bb/domain";
import type { ThreadTimelinePageRequest } from "./timeline-pagination.js";

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_CACHEABLE_ROWS = 200;
const DEFAULT_MAX_LARGE_ENTRIES = 4;

interface ThreadTimelineCacheOptions {
  maxEntries?: number;
  maxCacheableRows?: number;
  maxLargeEntries?: number;
}

interface ThreadTimelineCache {
  getOrBuild(
    threadId: string,
    key: string,
    build: () => ThreadTimelineResponse,
  ): ThreadTimelineResponse;
  invalidateThread(threadId: string): void;
  readonly size: number;
}

interface ThreadTimelineCacheEntry {
  large: boolean;
  response: ThreadTimelineResponse;
  threadId: string;
}

export function createThreadTimelineCache(
  options: ThreadTimelineCacheOptions = {},
): ThreadTimelineCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxCacheableRows =
    options.maxCacheableRows ?? DEFAULT_MAX_CACHEABLE_ROWS;
  const maxLargeEntries = options.maxLargeEntries ?? DEFAULT_MAX_LARGE_ENTRIES;
  const entries = new Map<string, ThreadTimelineCacheEntry>();
  let largeEntryCount = 0;

  function deleteEntry(key: string): void {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    if (entry.large) largeEntryCount -= 1;
  }

  function evictOldestWhile(
    over: () => boolean,
    evictable: (entry: ThreadTimelineCacheEntry) => boolean,
  ): void {
    for (const [key, entry] of entries) {
      if (!over()) return;
      if (evictable(entry)) deleteEntry(key);
    }
  }

  return {
    getOrBuild(threadId, key, build) {
      const cached = entries.get(key);
      if (cached !== undefined) {
        entries.delete(key);
        entries.set(key, cached);
        return cached.response;
      }

      const value = build();
      const large = value.rows.length > maxCacheableRows;
      if (large && maxLargeEntries === 0) {
        return value;
      }
      entries.set(key, { large, response: value, threadId });
      if (large) {
        largeEntryCount += 1;
        evictOldestWhile(
          () => largeEntryCount > maxLargeEntries,
          (entry) => entry.large,
        );
      }
      evictOldestWhile(
        () => entries.size > maxEntries,
        () => true,
      );
      return value;
    },
    invalidateThread(threadId) {
      for (const [key, entry] of entries) {
        if (entry.threadId === threadId) {
          deleteEntry(key);
        }
      }
    },
    get size() {
      return entries.size;
    },
  };
}

export interface ThreadTimelineCacheKeyArgs {
  threadId: string;
  maxSeq: number;
  status: ThreadStatus;
  surface: string;
  page: ThreadTimelinePageRequest;
  summaryOnly: boolean;
}

function pageKeyPart(page: ThreadTimelinePageRequest): string {
  return page.kind === "older"
    ? `older:${page.segmentLimit}:${page.beforeCursor.anchorSeq}:${page.beforeCursor.anchorId}`
    : `latest:${page.segmentLimit}`;
}

export function buildThreadTimelineParamsKey(
  args: Omit<ThreadTimelineCacheKeyArgs, "maxSeq">,
): string {
  return [
    args.threadId,
    args.status,
    args.surface,
    pageKeyPart(args.page),
    args.summaryOnly ? "1" : "0",
  ].join("|");
}

export function buildThreadTimelineCacheKey(
  args: ThreadTimelineCacheKeyArgs,
): string {
  return `${args.maxSeq}|${buildThreadTimelineParamsKey(args)}`;
}
