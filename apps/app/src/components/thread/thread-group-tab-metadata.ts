import { useQueries } from "@tanstack/react-query";
import type { ThreadListEntry } from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { shouldRetryTransientReadQuery } from "@/hooks/queries/query-helpers";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  THREAD_DETAIL_STALE_TIME_MS,
  useArchivedThreads,
} from "@/hooks/queries/thread-queries";
import { threadEntryMapFor } from "@/lib/plugin-sidebar-hooks";
import { sdk } from "@/lib/sdk";
import { getThreadDisplayTitle } from "@/lib/thread-title";

export type ThreadGroupTabMetadata =
  | {
      kind: "thread";
      title: string;
      projectId: string;
      archived: boolean;
      entry: ThreadListEntry | null;
    }
  | { kind: "loading" }
  | { kind: "unavailable" };

const LOADING: ThreadGroupTabMetadata = { kind: "loading" };
const UNAVAILABLE: ThreadGroupTabMetadata = { kind: "unavailable" };
const NO_ENTRIES: ReadonlyMap<string, ThreadListEntry> = new Map();

const archivedMaps = new WeakMap<
  readonly (readonly ThreadListEntry[])[],
  ReadonlyMap<string, ThreadListEntry>
>();

function archivedEntryMapFor(
  pages: readonly (readonly ThreadListEntry[])[] | undefined,
): ReadonlyMap<string, ThreadListEntry> {
  if (pages === undefined) return NO_ENTRIES;
  const cached = archivedMaps.get(pages);
  if (cached !== undefined) return cached;
  const entries = new Map(pages.flat().map((thread) => [thread.id, thread]));
  archivedMaps.set(pages, entries);
  return entries;
}

function fromEntry(
  entry: ThreadListEntry,
  archived: boolean,
): ThreadGroupTabMetadata {
  return {
    kind: "thread",
    title: getThreadDisplayTitle(entry),
    projectId: entry.projectId,
    archived,
    entry: archived ? null : entry,
  };
}

function fromDetail(thread: ThreadResponse): ThreadGroupTabMetadata {
  return {
    kind: "thread",
    title: getThreadDisplayTitle(thread),
    projectId: thread.projectId,
    archived: thread.archivedAt !== null,
    entry: null,
  };
}

export function useThreadGroupTabMetadata(
  threadIds: readonly string[],
): ReadonlyMap<string, ThreadGroupTabMetadata> {
  const navigation = useSidebarNavigation();
  const listed = threadEntryMapFor(navigation.data);
  const navigationSettled = navigation.data !== undefined || navigation.isError;
  const unlisted = threadIds.filter((id) => !listed.has(id));

  const archive = useArchivedThreads(
    {},
    { enabled: navigationSettled && unlisted.length > 0 },
  );
  const archived = archivedEntryMapFor(archive.data?.pages);
  const archiveSettled =
    navigationSettled && (archive.data !== undefined || archive.isError);

  const details = useQueries({
    queries: unlisted.map((threadId) => ({
      queryKey: threadQueryKey(threadId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        sdk.threads.get({ threadId, signal }),
      enabled: archiveSettled && !archived.has(threadId),
      staleTime: THREAD_DETAIL_STALE_TIME_MS,
      retry: shouldRetryTransientReadQuery,
    })),
  });

  const detailById = new Map(
    unlisted.map((threadId, index) => [threadId, details[index]]),
  );
  const metadata = new Map<string, ThreadGroupTabMetadata>();
  for (const threadId of threadIds) {
    const entry = listed.get(threadId);
    const detail = detailById.get(threadId);
    const archivedEntry = archived.get(threadId);
    metadata.set(
      threadId,
      entry !== undefined
        ? fromEntry(entry, false)
        : detail?.data !== undefined
          ? fromDetail(detail.data)
          : archivedEntry !== undefined
            ? fromEntry(archivedEntry, true)
            : detail?.isError === true
              ? UNAVAILABLE
              : LOADING,
    );
  }
  return metadata;
}
