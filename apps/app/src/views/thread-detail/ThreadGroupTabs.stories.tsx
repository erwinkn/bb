import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ThreadResponse } from "@bb/server-contract";
import type {
  ExperimentalThreadGroup,
  ExperimentalThreadGroupTabsRegistration,
} from "@get-bb/plugin-sdk";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider as JotaiProvider } from "jotai";
import { makeThread } from "../../../.ladle/story-fixtures";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  makeThreadResponse,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";
import {
  archivedThreadsListQueryKey,
  sidebarNavigationQueryKey,
  threadDetailBootstrapQueryKey,
  threadQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { SplitLayout } from "@/lib/split-layout";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { PluginThreadGroupTabs } from "@/components/plugin/PluginThreadGroupTabs";
import { DefaultPaneContextProvider } from "./PaneContext";
import { SplitThreadArea } from "./SplitThreadArea";
import { ThreadDetailHeader } from "./ThreadDetailHeader";

export default {
  title: "thread/Thread group tabs",
};

const PROJECT_ID = "proj_bb";
const PLUGIN_ID = "thread-group-example";

interface StoryThread {
  id: string;
  title: string;
  label?: string;
  pinned?: boolean;
  entry: Parameters<typeof makeThreadListEntry>[0];
}

const COORDINATOR: StoryThread = {
  id: "thr_group_coordinator",
  title: "Initiative: checkout reliability",
  label: "Coordinator",
  pinned: true,
  entry: { runtime: { displayStatus: "active" } },
};

const DISCUSSIONS: readonly StoryThread[] = [
  {
    id: "thr_group_auth",
    title: "Auth retries",
    entry: { hasPendingInteraction: true },
  },
  {
    id: "thr_group_perf",
    title: "Perf budget",
    entry: { status: "idle", latestAttentionAt: 10, lastReadAt: 0 },
  },
  { id: "thr_group_docs", title: "Docs pass", entry: {} },
];

const MANY_DISCUSSIONS: readonly StoryThread[] = [
  ...DISCUSSIONS,
  { id: "thr_group_flaky", title: "Flaky checkout tests", entry: {} },
  { id: "thr_group_mobile", title: "Mobile Safari layout", entry: {} },
  { id: "thr_group_rollout", title: "Staged rollout plan", entry: {} },
  { id: "thr_group_alerts", title: "Alert thresholds", entry: {} },
];

function storyGroup(
  discussions: readonly StoryThread[],
): ExperimentalThreadGroup {
  return {
    tabs: [COORDINATOR, ...discussions].map((thread) => ({
      threadId: thread.id,
      ...(thread.label === undefined ? {} : { label: thread.label }),
      ...(thread.pinned === undefined ? {} : { pinned: thread.pinned }),
    })),
    create: {
      label: "New discussion",
      onCreate: () => new Promise<void>((resolve) => setTimeout(resolve, 900)),
    },
  };
}

function groupRegistration(
  discussions: readonly StoryThread[],
): ExperimentalThreadGroupTabsRegistration {
  const group = storyGroup(discussions);
  const members = new Set(group.tabs.map((tab) => tab.threadId));
  return {
    id: "initiative",
    title: "Initiative threads",
    useThreadGroup: ({ threadId }) => (members.has(threadId) ? group : null),
  };
}

function storyThreadResponse(thread: StoryThread): ThreadResponse {
  return makeThreadResponse({
    ...makeThread({
      id: thread.id,
      projectId: PROJECT_ID,
      environmentId: null,
      title: thread.title,
      titleFallback: thread.title,
    }),
    canSpawnChild: false,
  });
}

function createStoryQueryClient(
  threads: readonly StoryThread[],
  archived: readonly StoryThread[] = [],
  loading: readonly string[] = [],
): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: {
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: Infinity,
      },
    },
  });
  for (const thread of threads) {
    const response = storyThreadResponse(thread);
    queryClient.setQueryData(
      threadDetailBootstrapQueryKey(thread.id),
      response,
    );
    queryClient.setQueryData(threadQueryKey(thread.id), response);
    queryClient.setQueryData(
      threadTimelineQueryKey(thread.id),
      makeThreadTimelineResponse({
        rows: [
          conversationRow({
            id: `${thread.id}:user:1`,
            role: "user",
            sourceSeqStart: 1,
            text: `Let's work on ${thread.title.toLowerCase()}.`,
            threadId: thread.id,
            turnId: `${thread.id}:turn:1`,
          }),
        ],
        maxSeq: 1,
      }),
    );
  }
  for (const threadId of loading) {
    void queryClient.prefetchQuery({
      queryKey: threadQueryKey(threadId),
      queryFn: () => new Promise<ThreadResponse>(() => {}),
    });
  }
  queryClient.setQueryData(archivedThreadsListQueryKey({}), {
    pageParams: [0],
    pages: [
      archived.map((thread) =>
        makeThreadListEntry({
          id: thread.id,
          projectId: PROJECT_ID,
          title: thread.title,
          archivedAt: 1,
        }),
      ),
    ],
  });
  queryClient.setQueryData(
    sidebarNavigationQueryKey(),
    makeSidebarBootstrapResponse({
      projects: [
        makeProjectWithThreadsResponse({
          id: PROJECT_ID,
          name: "bb",
          threads: threads.map((thread) =>
            makeThreadListEntry({
              id: thread.id,
              projectId: PROJECT_ID,
              title: thread.title,
              ...thread.entry,
            }),
          ),
        }),
      ],
    }),
  );
  return queryClient;
}

function useStoryGroupRegistration(discussions: readonly StoryThread[]) {
  useEffect(() => {
    setPluginSlotRegistrations(
      PLUGIN_ID,
      makePluginRegistrationSet({
        threadGroupTabs: [groupRegistration(discussions)],
      }),
    );
    return () => removePluginSlotRegistrations(PLUGIN_ID);
  }, [discussions]);
}

function ThreadGroupStory({
  discussions = DISCUSSIONS,
  split = false,
  width,
}: {
  discussions?: readonly StoryThread[];
  split?: boolean;
  width?: number;
}) {
  const threads = useMemo(() => [COORDINATOR, ...discussions], [discussions]);
  const queryClient = useMemo(() => createStoryQueryClient(threads), [threads]);
  const store = useMemo(() => {
    const nextStore = createStore();
    const layout: SplitLayout | null = split
      ? {
          root: {
            type: "split",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [COORDINATOR, DISCUSSIONS[0] ?? COORDINATOR].map(
              (thread, index) => ({
                type: "pane",
                paneId: `pane-${index}`,
                content: {
                  kind: "thread",
                  projectId: PROJECT_ID,
                  threadId: thread.id,
                },
              }),
            ),
          },
          focusedPaneId: "pane-0",
        }
      : null;
    nextStore.set(splitLayoutAtom, layout);
    return nextStore;
  }, [split]);

  useStoryGroupRegistration(discussions);

  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <ThreadActionsProvider>
          <SidebarProvider>
            <div
              className="flex h-screen min-h-[480px] w-full flex-col bg-background p-4 md:p-5"
              style={width === undefined ? undefined : { maxWidth: width }}
            >
              <SplitThreadArea
                routeContent={{
                  kind: "thread",
                  projectId: PROJECT_ID,
                  threadId: COORDINATOR.id,
                }}
              />
            </div>
          </SidebarProvider>
        </ThreadActionsProvider>
      </JotaiProvider>
    </QueryClientProvider>
  );
}

export function Coordinator() {
  return <ThreadGroupStory />;
}

export function SplitPanes() {
  return <ThreadGroupStory split />;
}

export function OverflowingDiscussions() {
  return <ThreadGroupStory discussions={MANY_DISCUSSIONS} width={640} />;
}

function HeaderStory({
  archived = [],
  loading = [],
  registration,
  threads,
}: {
  archived?: readonly StoryThread[];
  loading?: readonly string[];
  registration: ExperimentalThreadGroupTabsRegistration;
  threads: readonly StoryThread[];
}) {
  const queryClient = useMemo(
    () => createStoryQueryClient(threads, archived, loading),
    [threads, archived, loading],
  );
  useEffect(() => {
    setPluginSlotRegistrations(
      PLUGIN_ID,
      makePluginRegistrationSet({ threadGroupTabs: [registration] }),
    );
    return () => removePluginSlotRegistrations(PLUGIN_ID);
  }, [registration]);
  return (
    <QueryClientProvider client={queryClient}>
      <ThreadActionsProvider>
        <SidebarProvider>
          <DefaultPaneContextProvider
            onRequestClose={null}
            navigateInPane={() => {}}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <ThreadDetailHeader
                actionsMenu={null}
                childPillLabel={null}
                isSecondaryPanelOpen={false}
                onOpenThreadGitAction={() => {}}
                onToggleSecondaryPanel={() => {}}
                renderTitle={(title) => (
                  <PluginThreadGroupTabs
                    fallback={title}
                    projectId={PROJECT_ID}
                    threadId={COORDINATOR.id}
                  />
                )}
                threadHeaderGitActions={[]}
                threadId={COORDINATOR.id}
                threadTitle={COORDINATOR.title}
              />
            </div>
          </DefaultPaneContextProvider>
        </SidebarProvider>
      </ThreadActionsProvider>
    </QueryClientProvider>
  );
}

const HEADER_THREADS = [COORDINATOR, ...MANY_DISCUSSIONS];
const HEADER_REGISTRATION = groupRegistration(MANY_DISCUSSIONS);

export function HeaderOnly() {
  return (
    <HeaderStory registration={HEADER_REGISTRATION} threads={HEADER_THREADS} />
  );
}

function fixedGroup(
  group: ExperimentalThreadGroup,
): ExperimentalThreadGroupTabsRegistration {
  return {
    id: "initiative",
    title: "Initiative threads",
    useThreadGroup: () => group,
  };
}

const NARROW_THREADS = [COORDINATOR, ...DISCUSSIONS];

const LONG_PINNED = fixedGroup({
  tabs: [
    {
      threadId: COORDINATOR.id,
      label: "Coordinator for checkout reliability initiative",
      pinned: true,
    },
    { threadId: "thr_group_auth" },
    { threadId: "thr_group_perf" },
  ],
  create: { label: "New discussion", onCreate: () => {} },
});

export function LongPinnedLabel() {
  return <HeaderStory registration={LONG_PINNED} threads={NARROW_THREADS} />;
}

const SEVERAL_PINNED = fixedGroup({
  tabs: [
    { threadId: COORDINATOR.id, label: "Coordinator", pinned: true },
    { threadId: "thr_group_auth", pinned: true },
    { threadId: "thr_group_perf", pinned: true },
    { threadId: "thr_group_docs" },
  ],
  create: { label: "New discussion", onCreate: () => {} },
});

export function SeveralPinned() {
  return <HeaderStory registration={SEVERAL_PINNED} threads={NARROW_THREADS} />;
}

const LOADING_PINS = ["thr_group_loading_a", "thr_group_loading_b"];

const PINNED_LOADING = fixedGroup({
  tabs: [
    { threadId: COORDINATOR.id, label: "Coordinator", pinned: true },
    ...LOADING_PINS.map((threadId) => ({ threadId, pinned: true })),
    { threadId: "thr_group_docs" },
  ],
  create: { label: "New discussion", onCreate: () => {} },
});

export function PinnedLoading() {
  return (
    <HeaderStory
      loading={LOADING_PINS}
      registration={PINNED_LOADING}
      threads={NARROW_THREADS}
    />
  );
}

const ARCHIVED_DISCUSSION: StoryThread = {
  id: "thr_group_retro",
  title: "Launch retro",
  entry: {},
};

const OFF_SIDEBAR = fixedGroup({
  tabs: [
    { threadId: COORDINATOR.id, label: "Coordinator", pinned: true },
    { threadId: "thr_group_auth" },
    { threadId: ARCHIVED_DISCUSSION.id },
    { threadId: "thr_group_deleted" },
  ],
});
const OFF_SIDEBAR_ARCHIVE = [ARCHIVED_DISCUSSION];

export function ThreadsOffTheSidebar() {
  return (
    <HeaderStory
      archived={OFF_SIDEBAR_ARCHIVE}
      registration={OFF_SIDEBAR}
      threads={NARROW_THREADS}
    />
  );
}

let liveTabs: ExperimentalThreadGroup["tabs"] = [
  { threadId: "thr_group_auth" },
  { threadId: COORDINATOR.id, label: "Coordinator" },
];
const liveListeners = new Set<() => void>();

function setLiveTabs(next: ExperimentalThreadGroup["tabs"]) {
  liveTabs = next;
  for (const listener of liveListeners) listener();
}

function subscribeLiveTabs(listener: () => void) {
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}

const LIVE_GROUP: ExperimentalThreadGroupTabsRegistration = {
  id: "initiative",
  title: "Initiative threads",
  useThreadGroup: () => {
    const tabs = useSyncExternalStore(subscribeLiveTabs, () => liveTabs);
    return { tabs: [...tabs] };
  },
};

export function LiveGroupUpdates() {
  const many = MANY_DISCUSSIONS.map((thread) => ({ threadId: thread.id }));
  return (
    <div className="flex flex-col gap-3">
      <div className="w-[520px]">
        <HeaderStory registration={LIVE_GROUP} threads={HEADER_THREADS} />
      </div>
      <div className="flex gap-2 px-4 text-sm">
        <button
          type="button"
          data-story-action="insert"
          onClick={() =>
            setLiveTabs([
              ...many,
              { threadId: COORDINATOR.id, label: "Coordinator" },
            ])
          }
        >
          Insert 7 before
        </button>
        <button
          type="button"
          data-story-action="pin"
          onClick={() =>
            setLiveTabs(
              liveTabs.map((tab, index) =>
                index === 0 ? { ...tab, pinned: !tab.pinned } : tab,
              ),
            )
          }
        >
          Toggle pin on first
        </button>
        <button
          type="button"
          data-story-action="same"
          onClick={() => setLiveTabs([...liveTabs])}
        >
          Same group, new array
        </button>
      </div>
    </div>
  );
}
