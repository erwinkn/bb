import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { isThreadRead } from "@bb/client-core";
import type { ThreadListEntry } from "@bb/domain";
import {
  isThreadOpenCacheActive,
  listRecentThreadOpenCacheIds,
  touchThreadOpenCache,
} from "../cache-owners/thread-open-cache-owner";
import {
  prefetchThreadOpen,
  THREAD_DETAIL_STALE_TIME_MS,
} from "./thread-queries";

export const THREAD_HOVER_PREFETCH_DELAY_MS = 150;
export const THREAD_ACTIVITY_PREFETCH_BATCH_MS = 500;
export const THREAD_ACTIVITY_PREFETCH_CONCURRENCY = 2;
export const THREAD_ACTIVITY_PREFETCH_RECENT_THREADS = 10;

type ThreadActivityPrefetchCandidate = Pick<
  ThreadListEntry,
  "archivedAt" | "id" | "lastReadAt" | "latestAttentionAt" | "pinnedAt"
>;

interface ThreadActivityPrefetchState {
  batch: Set<string>;
  batchTimer: ReturnType<typeof setTimeout> | null;
  prefetchedAttentionAt: Map<string, number>;
  queue: Set<string>;
  running: Set<string>;
}

const activityPrefetchStateByClient = new WeakMap<
  QueryClient,
  ThreadActivityPrefetchState
>();

function getActivityPrefetchState(
  queryClient: QueryClient,
): ThreadActivityPrefetchState {
  let state = activityPrefetchStateByClient.get(queryClient);
  if (state === undefined) {
    state = {
      batch: new Set(),
      batchTimer: null,
      prefetchedAttentionAt: new Map(),
      queue: new Set(),
      running: new Set(),
    };
    activityPrefetchStateByClient.set(queryClient, state);
  }
  return state;
}

async function prefetchClosedThread(
  queryClient: QueryClient,
  threadId: string,
  timelineStaleTime: number,
): Promise<void> {
  if (
    isThreadOpenCacheActive(queryClient, threadId) ||
    !touchThreadOpenCache(queryClient, threadId)
  ) {
    return;
  }
  await prefetchThreadOpen({ queryClient, threadId, timelineStaleTime });
}

function drainActivityPrefetches(
  queryClient: QueryClient,
  state: ThreadActivityPrefetchState,
): void {
  for (const threadId of state.queue) {
    if (state.running.size >= THREAD_ACTIVITY_PREFETCH_CONCURRENCY) {
      return;
    }
    if (state.running.has(threadId)) {
      continue;
    }
    state.queue.delete(threadId);
    state.running.add(threadId);
    void prefetchClosedThread(queryClient, threadId, 0).finally(() => {
      state.running.delete(threadId);
      drainActivityPrefetches(queryClient, state);
    });
  }
}

export function scheduleThreadActivityPrefetches(
  queryClient: QueryClient,
  threads: readonly ThreadActivityPrefetchCandidate[],
): void {
  const state = getActivityPrefetchState(queryClient);
  const recentThreadIds = new Set(
    listRecentThreadOpenCacheIds(
      queryClient,
      THREAD_ACTIVITY_PREFETCH_RECENT_THREADS,
    ),
  );
  for (const thread of threads) {
    if (
      thread.archivedAt !== null ||
      isThreadRead(thread) ||
      (thread.pinnedAt === null && !recentThreadIds.has(thread.id)) ||
      state.prefetchedAttentionAt.get(thread.id) === thread.latestAttentionAt
    ) {
      continue;
    }
    state.prefetchedAttentionAt.set(thread.id, thread.latestAttentionAt);
    state.batch.add(thread.id);
  }
  if (state.batch.size === 0 || state.batchTimer !== null) {
    return;
  }
  state.batchTimer = setTimeout(() => {
    state.batchTimer = null;
    for (const threadId of state.batch) {
      state.queue.add(threadId);
    }
    state.batch.clear();
    drainActivityPrefetches(queryClient, state);
  }, THREAD_ACTIVITY_PREFETCH_BATCH_MS);
}

export function useThreadActivityPrefetch(
  threads: readonly ThreadActivityPrefetchCandidate[],
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    scheduleThreadActivityPrefetches(queryClient, threads);
  }, [queryClient, threads]);
}

export function scheduleThreadHoverPrefetch(
  queryClient: QueryClient,
  threadId: string,
): () => void {
  const timer = setTimeout(() => {
    void prefetchClosedThread(
      queryClient,
      threadId,
      THREAD_DETAIL_STALE_TIME_MS,
    );
  }, THREAD_HOVER_PREFETCH_DELAY_MS);
  return () => clearTimeout(timer);
}

export function useThreadHoverPrefetch(): (threadId: string) => () => void {
  const queryClient = useQueryClient();
  return useCallback(
    (threadId: string) => scheduleThreadHoverPrefetch(queryClient, threadId),
    [queryClient],
  );
}
