// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadResponse,
  ThreadTimelineResponse,
  ThreadWithIncludesResponse,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  makeThreadResponse,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";
import {
  THREAD_OPEN_CACHE_MAX_THREADS,
  touchThreadOpenCache,
} from "../cache-owners/thread-open-cache-owner";
import { TRANSIENT_READ_RETRY_DELAY_MS } from "./query-helpers";
import {
  threadDetailBootstrapQueryKey,
  threadQueryKey,
  threadTimelineQueryKey,
} from "./query-keys";
import {
  scheduleThreadActivityPrefetches,
  scheduleThreadHoverPrefetch,
  THREAD_ACTIVITY_PREFETCH_BATCH_MS,
  THREAD_ACTIVITY_PREFETCH_CONCURRENCY,
  THREAD_HOVER_PREFETCH_DELAY_MS,
} from "./thread-prefetch";
import { useThreadDetailBootstrap, useThreadTimeline } from "./thread-queries";

vi.mock("@/lib/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdk")>()),
  sdk: {
    threads: {
      get: vi.fn(),
      timeline: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
  useThreadListRealtimeSubscription: vi.fn(),
}));

type QueryClient = ReturnType<
  typeof createQueryClientTestHarness
>["queryClient"];

interface ListedThread {
  archivedAt: number | null;
  id: string;
  lastReadAt: number | null;
  latestAttentionAt: number;
  pinnedAt: number | null;
}

function makeRow(
  threadId: string,
  seq: number,
): ThreadTimelineResponse["rows"][number] {
  return {
    id: `${threadId}-row-${seq}`,
    kind: "system",
    threadId,
    turnId: null,
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    startedAt: seq,
    createdAt: seq,
    systemKind: "debug",
    title: `Row ${seq}`,
    detail: null,
    status: null,
  };
}

function makeTimeline(threadId: string, seq: number): ThreadTimelineResponse {
  return makeThreadTimelineResponse({
    rows: [makeRow(threadId, seq)],
    maxSeq: seq,
  });
}

function makeBootstrap(threadId: string): ThreadWithIncludesResponse {
  return {
    ...makeThreadResponse({ id: threadId, projectId: "project-1" }),
    environment: null,
    host: null,
  };
}

function unreadThread(id: string, latestAttentionAt = 10): ListedThread {
  return {
    archivedAt: null,
    id,
    lastReadAt: 1,
    latestAttentionAt,
    pinnedAt: null,
  };
}

function prefetchedThreadIds(): string[] {
  return vi.mocked(sdk.threads.get).mock.calls.map(([args]) => args.threadId);
}

function timelineCalls() {
  return vi.mocked(sdk.threads.timeline).mock.calls.map(([args]) => args);
}

function openRecently(queryClient: QueryClient, ...threadIds: string[]) {
  for (const threadId of threadIds) {
    touchThreadOpenCache(queryClient, threadId);
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(sdk.threads.get).mockImplementation(async ({ threadId }) =>
    makeBootstrap(threadId),
  );
  vi.mocked(sdk.threads.timeline).mockImplementation(async ({ threadId }) =>
    makeTimeline(threadId, 5),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("scheduleThreadActivityPrefetches", () => {
  it("prefetches an unread recently opened thread after the batch window", async () => {
    const { queryClient } = createQueryClientTestHarness();
    openRecently(queryClient, "thread-1");

    scheduleThreadActivityPrefetches(queryClient, [unreadThread("thread-1")]);
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS - 1);
    expect(sdk.threads.get).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(prefetchedThreadIds()).toEqual(["thread-1"]);
    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
    ).toEqual(makeTimeline("thread-1", 5));
    expect(
      queryClient.getQueryData(threadDetailBootstrapQueryKey("thread-1")),
    ).toEqual(makeBootstrap("thread-1"));
  });

  it("skips read, archived and unrecent threads but keeps unread pinned ones", async () => {
    const { queryClient } = createQueryClientTestHarness();
    openRecently(queryClient, "read", "archived");

    scheduleThreadActivityPrefetches(queryClient, [
      { ...unreadThread("read"), lastReadAt: 10 },
      { ...unreadThread("archived"), archivedAt: 5 },
      unreadThread("never-opened"),
      { ...unreadThread("pinned"), pinnedAt: 3 },
    ]);
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS);

    expect(prefetchedThreadIds()).toEqual(["pinned"]);
  });

  it("fetches once per attention change and refreshes the timeline as a delta", async () => {
    const { queryClient } = createQueryClientTestHarness();
    openRecently(queryClient, "thread-1");

    scheduleThreadActivityPrefetches(queryClient, [unreadThread("thread-1")]);
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS);
    scheduleThreadActivityPrefetches(queryClient, [unreadThread("thread-1")]);
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS);
    expect(timelineCalls()).toHaveLength(1);

    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce({
      ...makeTimeline("thread-1", 5),
      rows: [],
      maxSeq: 8,
      delta: {
        upsertRows: [makeRow("thread-1", 8)],
        rowOrder: ["thread-1-row-5", "thread-1-row-8"],
      },
    });
    scheduleThreadActivityPrefetches(queryClient, [
      unreadThread("thread-1", 20),
    ]);
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS);

    expect(timelineCalls()[1]).toMatchObject({
      threadId: "thread-1",
      afterSequence: "5",
    });
    expect(
      queryClient
        .getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1"),
        )
        ?.rows.map((row) => row.id),
    ).toEqual(["thread-1-row-5", "thread-1-row-8"]);
    expect(sdk.threads.get).toHaveBeenCalledTimes(1);
  });

  it("runs a bounded number of threads at a time and coalesces a burst", async () => {
    const { queryClient } = createQueryClientTestHarness();
    const threadIds = ["a", "b", "c", "d", "e"];
    openRecently(queryClient, ...threadIds);
    const timelines = new Map(
      threadIds.map((threadId) => [
        threadId,
        deferred<ThreadTimelineResponse>(),
      ]),
    );
    vi.mocked(sdk.threads.timeline).mockImplementation(
      ({ threadId }) => timelines.get(threadId)!.promise,
    );

    for (const threadId of threadIds) {
      scheduleThreadActivityPrefetches(queryClient, [unreadThread(threadId)]);
    }
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS);
    expect(timelineCalls().map((call) => call.threadId)).toEqual(
      threadIds.slice(0, THREAD_ACTIVITY_PREFETCH_CONCURRENCY),
    );

    timelines.get("a")!.resolve(makeTimeline("a", 5));
    await vi.advanceTimersByTimeAsync(0);
    expect(timelineCalls().map((call) => call.threadId)).toEqual([
      "a",
      "b",
      "c",
    ]);

    for (const threadId of threadIds) {
      timelines.get(threadId)!.resolve(makeTimeline(threadId, 5));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(timelineCalls().map((call) => call.threadId)).toEqual(threadIds);
  });

  it("holds activity that arrives during a fetch until its own batch window closes", async () => {
    const { queryClient } = createQueryClientTestHarness();
    openRecently(queryClient, "thread-1");
    const firstTimeline = deferred<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(firstTimeline.promise);

    scheduleThreadActivityPrefetches(queryClient, [unreadThread("thread-1")]);
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS);
    scheduleThreadActivityPrefetches(queryClient, [
      unreadThread("thread-1", 20),
    ]);
    firstTimeline.resolve(makeTimeline("thread-1", 5));
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS - 1);
    expect(timelineCalls()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(timelineCalls()).toHaveLength(2);
  });

  it("leaves a thread that is open to its live updates", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    renderHook(() => useThreadTimeline("thread-1"), { wrapper });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(sdk.threads.timeline).mockClear();

    scheduleThreadActivityPrefetches(queryClient, [unreadThread("thread-1")]);
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS);

    expect(sdk.threads.timeline).not.toHaveBeenCalled();
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });
});

describe("scheduleThreadHoverPrefetch", () => {
  it("does nothing when the pointer passes before the delay", async () => {
    const { queryClient } = createQueryClientTestHarness();

    const cancel = scheduleThreadHoverPrefetch(queryClient, "thread-1");
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS - 1);
    cancel();
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);

    expect(sdk.threads.get).not.toHaveBeenCalled();
    expect(sdk.threads.timeline).not.toHaveBeenCalled();
  });

  it("prefetches after the delay and skips a timeline fetched moments ago", async () => {
    const { queryClient } = createQueryClientTestHarness();

    scheduleThreadHoverPrefetch(queryClient, "thread-1");
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);
    scheduleThreadHoverPrefetch(queryClient, "thread-1");
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);

    expect(prefetchedThreadIds()).toEqual(["thread-1"]);
    expect(timelineCalls()).toHaveLength(1);
  });

  it("fetches nothing when every cached thread is open", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const openThreadIds = Array.from(
      { length: THREAD_OPEN_CACHE_MAX_THREADS },
      (_, index) => `open-${index}`,
    );
    renderHook(() => openThreadIds.map((id) => useThreadTimeline(id)), {
      wrapper,
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(sdk.threads.timeline).mockClear();

    scheduleThreadHoverPrefetch(queryClient, "thread-1");
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);

    expect(sdk.threads.get).not.toHaveBeenCalled();
    expect(sdk.threads.timeline).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
    ).toBeUndefined();
  });
});

describe("opening a prefetched thread", () => {
  it("keeps the view's retry when it opens during a prefetch that fails", async () => {
    const { wrapper, queryClient } = createQueryClientTestHarness();
    const firstTimeline = deferred<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(
      firstTimeline.promise.then(() => {
        throw new TypeError("Failed to fetch");
      }),
    );
    scheduleThreadHoverPrefetch(queryClient, "thread-1");
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);

    const { result } = renderHook(() => useThreadTimeline("thread-1"), {
      wrapper,
    });
    expect(result.current.data).toBeUndefined();
    firstTimeline.resolve(makeTimeline("thread-1", 5));
    await vi.advanceTimersByTimeAsync(TRANSIENT_READ_RETRY_DELAY_MS);

    expect(timelineCalls()[1]).not.toHaveProperty("afterSequence");
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      )?.rows,
    ).toEqual([makeRow("thread-1", 5)]);
  });

  it("renders the cached detail and timeline on the first render", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    scheduleThreadHoverPrefetch(queryClient, "thread-1");
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);

    const { result } = renderHook(
      () => ({
        bootstrap: useThreadDetailBootstrap("thread-1"),
        timeline: useThreadTimeline("thread-1"),
      }),
      { wrapper },
    );

    expect(result.current.bootstrap.data).toEqual(makeBootstrap("thread-1"));
    expect(result.current.timeline.data?.rows).toEqual([
      makeRow("thread-1", 5),
    ]);
  });

  it.each([
    ["while its prefetch is in flight", 0],
    ["right after its prefetch lands", THREAD_HOVER_PREFETCH_DELAY_MS],
  ])(
    "fetches what changed before the view subscribed when opened %s",
    async (_timing, openDelayMs) => {
      const { queryClient, wrapper } = createQueryClientTestHarness();
      const prefetchedTimeline = deferred<ThreadTimelineResponse>();
      vi.mocked(sdk.threads.timeline)
        .mockReturnValueOnce(prefetchedTimeline.promise)
        .mockResolvedValueOnce({
          ...makeTimeline("thread-1", 5),
          rows: [],
          maxSeq: 6,
          delta: {
            upsertRows: [makeRow("thread-1", 6)],
            rowOrder: ["thread-1-row-5", "thread-1-row-6"],
          },
        });
      scheduleThreadHoverPrefetch(queryClient, "thread-1");
      await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);
      if (openDelayMs > 0) {
        prefetchedTimeline.resolve(makeTimeline("thread-1", 5));
        await vi.advanceTimersByTimeAsync(openDelayMs);
      }

      renderHook(() => useThreadTimeline("thread-1"), { wrapper });
      prefetchedTimeline.resolve(makeTimeline("thread-1", 5));
      await vi.advanceTimersByTimeAsync(0);

      expect(timelineCalls()).toHaveLength(2);
      expect(timelineCalls()[1]).toMatchObject({ afterSequence: "5" });
      expect(
        queryClient
          .getQueryData<ThreadTimelineResponse>(
            threadTimelineQueryKey("thread-1"),
          )
          ?.rows.map((row) => row.id),
      ).toEqual(["thread-1-row-5", "thread-1-row-6"]);
    },
  );

  it("refreshes prefetched thread details once the view subscribes", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    vi.mocked(sdk.threads.get)
      .mockResolvedValueOnce({ ...makeBootstrap("thread-1"), status: "active" })
      .mockResolvedValueOnce({ ...makeBootstrap("thread-1"), status: "idle" });
    scheduleThreadHoverPrefetch(queryClient, "thread-1");
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);

    const { result } = renderHook(() => useThreadDetailBootstrap("thread-1"), {
      wrapper,
    });
    expect(result.current.data?.status).toBe("active");
    await vi.advanceTimersByTimeAsync(0);

    expect(sdk.threads.get).toHaveBeenCalledTimes(2);
    expect(
      queryClient.getQueryData<ThreadResponse>(threadQueryKey("thread-1"))
        ?.status,
    ).toBe("idle");
  });

  it("makes one delta request when hover and activity share a prefetch", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    openRecently(queryClient, "thread-1");
    const prefetchedTimeline = deferred<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(
      prefetchedTimeline.promise,
    );
    scheduleThreadActivityPrefetches(queryClient, [unreadThread("thread-1")]);
    await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_PREFETCH_BATCH_MS);
    scheduleThreadHoverPrefetch(queryClient, "thread-1");
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);

    renderHook(() => useThreadTimeline("thread-1"), { wrapper });
    prefetchedTimeline.resolve(makeTimeline("thread-1", 5));
    await vi.advanceTimersByTimeAsync(0);

    expect(timelineCalls()).toHaveLength(2);
    expect(
      vi
        .mocked(sdk.threads.timeline)
        .mock.calls.filter(([args]) => args.signal?.aborted),
    ).toEqual([]);
  });

  it("shows the cached rows and fetches what changed since the prefetch", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    scheduleThreadHoverPrefetch(queryClient, "thread-1");
    await vi.advanceTimersByTimeAsync(THREAD_HOVER_PREFETCH_DELAY_MS);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce({
      ...makeTimeline("thread-1", 5),
      rows: [],
      maxSeq: 6,
      delta: {
        upsertRows: [makeRow("thread-1", 6)],
        rowOrder: ["thread-1-row-5", "thread-1-row-6"],
      },
    });

    const { result } = renderHook(() => useThreadTimeline("thread-1"), {
      wrapper,
    });
    expect(result.current.data?.rows.map((row) => row.id)).toEqual([
      "thread-1-row-5",
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(timelineCalls()[1]).toMatchObject({ afterSequence: "5" });
    expect(result.current.data?.rows.map((row) => row.id)).toEqual([
      "thread-1-row-5",
      "thread-1-row-6",
    ]);
  });
});
