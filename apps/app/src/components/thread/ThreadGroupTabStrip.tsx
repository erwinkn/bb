import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { threadListIndicatorStateForThread } from "@bb/client-core";
import type {
  ExperimentalThreadGroup,
  ExperimentalThreadGroupCreateAction,
  ExperimentalThreadGroupTab,
} from "@get-bb/plugin-sdk";
import { Button } from "@bb/shared-ui/button";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@/components/ui/context-selection";
import { appToast } from "@/components/ui/app-toast";
import { usePromptDraftHasInput } from "@/hooks/usePromptDraftStorage";
import { resolveThreadProjectId } from "@/hooks/queries/thread-queries";
import {
  getBbDesktopInfo,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { usePluginThreadRowStatus } from "@/lib/plugin-thread-row-status";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import { usePaneContext } from "@/views/thread-detail/PaneContext";
import {
  type ThreadGroupTabMetadata,
  useThreadGroupTabMetadata,
} from "./thread-group-tab-metadata";
import { resolveThreadStatus, ThreadStatusGlyph } from "./ThreadStatusGlyph";

const EDGE_EPSILON_PX = 1;
const EDGE_FADE_PX = 24;
const EDGE_FADE = `${EDGE_FADE_PX}px`;
const FOCUS_HANDOFF_TTL_MS = 5_000;

let focusHandoff: {
  expiresAt: number;
  paneId: string;
  threadId: string;
} | null = null;

function requestFocusHandoff(paneId: string, threadId: string) {
  focusHandoff = {
    expiresAt: Date.now() + FOCUS_HANDOFF_TTL_MS,
    paneId,
    threadId,
  };
}

function takeFocusHandoff(paneId: string, threadId: string): boolean {
  const handoff = focusHandoff;
  if (handoff?.paneId !== paneId || handoff.threadId !== threadId) {
    return false;
  }
  focusHandoff = null;
  return Date.now() <= handoff.expiresAt;
}

export function resetThreadGroupTabFocusHandoffForTest() {
  focusHandoff = null;
}

export interface NormalizedThreadGroup {
  pinned: readonly ExperimentalThreadGroupTab[];
  scrolling: readonly ExperimentalThreadGroupTab[];
  create: ExperimentalThreadGroupCreateAction | null;
}

export function normalizeThreadGroup(
  group: ExperimentalThreadGroup | null,
): NormalizedThreadGroup | null {
  if (group === null || !Array.isArray(group.tabs)) return null;
  const seen = new Set<string>();
  const pinned: ExperimentalThreadGroupTab[] = [];
  const scrolling: ExperimentalThreadGroupTab[] = [];
  for (const tab of group.tabs) {
    if (typeof tab?.threadId !== "string" || tab.threadId.length === 0) {
      continue;
    }
    if (seen.has(tab.threadId)) continue;
    seen.add(tab.threadId);
    (tab.pinned === true ? pinned : scrolling).push(tab);
  }
  if (seen.size === 0) return null;
  const create =
    group.create !== undefined && typeof group.create.onCreate === "function"
      ? group.create
      : null;
  return { pinned, scrolling, create };
}

interface ScrollEdges {
  left: boolean;
  right: boolean;
}

const NO_EDGES: ScrollEdges = { left: false, right: false };

function edgeMask({ left, right }: ScrollEdges): CSSProperties | undefined {
  if (!left && !right) return undefined;
  const start = left ? `transparent, #000 ${EDGE_FADE}` : "#000";
  const end = right ? `#000 calc(100% - ${EDGE_FADE}), transparent` : "#000";
  const maskImage = `linear-gradient(to right, ${start}, ${end})`;
  return { maskImage, WebkitMaskImage: maskImage };
}

function useHorizontalOverflow(revealKey: string, hasScrollingTabs: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
    const left = viewport.scrollLeft > EDGE_EPSILON_PX;
    const right = viewport.scrollLeft < maxScrollLeft - EDGE_EPSILON_PX;
    setEdges((previous) =>
      previous.left === left && previous.right === right
        ? previous
        : { left, right },
    );
  }, []);

  const reveal = useCallback(() => {
    const viewport = viewportRef.current;
    const active = viewport?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    if (viewport != null && active != null) {
      const bounds = viewport.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      const margin = Math.min(
        EDGE_FADE_PX,
        Math.max(0, (bounds.width - tab.width) / 2),
      );
      if (tab.left < bounds.left + margin) {
        viewport.scrollLeft -= bounds.left + margin - tab.left;
      } else if (tab.right > bounds.right - margin) {
        viewport.scrollLeft += tab.right - (bounds.right - margin);
      }
    }
    measure();
  }, [measure]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
      const next = Math.min(
        maxScrollLeft,
        Math.max(0, viewport.scrollLeft + event.deltaY),
      );
      if (Math.abs(next - viewport.scrollLeft) <= EDGE_EPSILON_PX) return;
      viewport.scrollLeft = next;
      event.preventDefault();
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(viewport);
    if (contentRef.current !== null) observer.observe(contentRef.current);
    viewport.addEventListener("scroll", measure, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", measure);
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, [hasScrollingTabs, measure, reveal]);

  useLayoutEffect(reveal, [revealKey, reveal]);

  return { contentRef, edges, viewportRef };
}

function moveTabFocus(event: ReactKeyboardEvent<HTMLElement>) {
  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
  ];
  const { target } = event;
  if (!(target instanceof HTMLElement)) return;
  const current = tabs.indexOf(target);
  if (current === -1) return;
  const last = tabs.length - 1;
  const next =
    event.key === "ArrowRight"
      ? current === last
        ? 0
        : current + 1
      : event.key === "ArrowLeft"
        ? current === 0
          ? last
          : current - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : null;
  if (next === null) return;
  event.preventDefault();
  tabs[next]?.focus();
}

interface ThreadGroupTabStripProps {
  ariaLabel: string;
  group: NormalizedThreadGroup;
  threadId: string;
}

export function ThreadGroupTabStrip({
  ariaLabel,
  group,
  threadId,
}: ThreadGroupTabStripProps) {
  const queryClient = useQueryClient();
  const { beginPaneDrag, isFocused, isSplitPane, navigateInPane, paneId } =
    usePaneContext();
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const [desktopInfo] = useState(getBbDesktopInfo);
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const threadIds = [...group.pinned, ...group.scrolling].map(
    (tab) => tab.threadId,
  );
  const hasPinnedTabs = group.pinned.length > 0;
  const hasScrollingTabs = group.scrolling.length > 0;
  const { contentRef, edges, viewportRef } = useHorizontalOverflow(
    `${threadId}|${group.pinned.length}|${threadIds.join()}`,
    hasScrollingTabs,
  );
  const metadata = useThreadGroupTabMetadata(threadIds);
  const hasActiveTab = threadIds.includes(threadId);
  const firstThreadId = threadIds[0];

  const openThread = useCallback(
    (targetThreadId: string, keepFocus: boolean) => {
      if (keepFocus) requestFocusHandoff(paneId, targetThreadId);
      resolveThreadProjectId(queryClient, targetThreadId)
        .then((projectId) =>
          navigateInPane({ projectId, threadId: targetThreadId }),
        )
        .catch(() => {
          appToast.error("Couldn't open thread");
        });
    },
    [navigateInPane, paneId, queryClient],
  );

  const renderTab = (tab: ExperimentalThreadGroupTab) => {
    const isActive = tab.threadId === threadId;
    return (
      <ThreadGroupTab
        key={tab.threadId}
        isActive={isActive}
        isFocusable={
          isActive || (!hasActiveTab && tab.threadId === firstThreadId)
        }
        isPaneFocused={!isSplitPane || isFocused}
        isPinned={tab.pinned === true}
        label={tab.label}
        metadata={metadata.get(tab.threadId) ?? { kind: "loading" }}
        onBeginPaneDrag={isActive ? beginPaneDrag : undefined}
        onSelect={
          isActive
            ? undefined
            : (event) => openThread(tab.threadId, event.detail === 0)
        }
        paneId={paneId}
        threadId={tab.threadId}
      />
    );
  };

  return (
    <div
      data-thread-group-tabs=""
      className={cn(
        "flex min-w-0 items-center gap-1",
        isSplitPane &&
          !isFocused &&
          dimsInactiveSplits &&
          CONTEXT_INACTIVE_TEXT_CLASS,
        usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
      )}
    >
      <div
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className={cn(
          "min-w-0 items-center gap-1",
          hasPinnedTabs && hasScrollingTabs
            ? "grid grid-cols-[minmax(0,max-content)_minmax(0,max-content)]"
            : "flex",
        )}
        onKeyDown={moveTabFocus}
      >
        {hasPinnedTabs ? (
          <div className="flex min-w-0 items-center gap-1">
            {group.pinned.map(renderTab)}
          </div>
        ) : null}
        {hasScrollingTabs ? (
          <div
            ref={viewportRef}
            className="no-scrollbar min-w-0 overflow-x-auto overflow-y-hidden"
            style={edgeMask(edges)}
          >
            <div ref={contentRef} className="flex w-max items-center gap-1">
              {group.scrolling.map(renderTab)}
            </div>
          </div>
        ) : null}
      </div>
      {group.create ? (
        <CreateThreadButton action={group.create} onCreated={openThread} />
      ) : null}
    </div>
  );
}

interface ThreadGroupTabProps {
  isActive: boolean;
  isFocusable: boolean;
  isPaneFocused: boolean;
  isPinned: boolean;
  label: string | undefined;
  metadata: ThreadGroupTabMetadata;
  onBeginPaneDrag:
    | ((event: ReactPointerEvent, label: string) => void)
    | undefined;
  onSelect: ((event: ReactMouseEvent) => void) | undefined;
  paneId: string;
  threadId: string;
}

function ThreadGroupTab({
  isActive,
  isFocusable,
  isPaneFocused,
  isPinned,
  label,
  metadata,
  onBeginPaneDrag,
  onSelect,
  paneId,
  threadId,
}: ThreadGroupTabProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const thread = metadata.kind === "thread" ? metadata : null;
  const entry = thread?.entry ?? null;
  const hasUnsubmittedDraft = usePromptDraftHasInput({
    kind: "thread",
    projectId: thread?.projectId ?? "",
    threadId,
  });
  const pluginStatus = usePluginThreadRowStatus(threadId);
  const text =
    label ??
    thread?.title ??
    (metadata.kind === "unavailable" ? "Unavailable thread" : null);
  const statusState =
    entry === null
      ? null
      : threadListIndicatorStateForThread(entry, hasUnsubmittedDraft);
  const statusLabel =
    metadata.kind === "loading"
      ? text === null
        ? null
        : "Loading"
      : metadata.kind === "unavailable"
        ? "Thread unavailable"
        : thread?.archived === true
          ? "Archived thread"
          : statusState === null
            ? null
            : resolveThreadStatus(statusState, pluginStatus).accessibleLabel;
  const accessibleText = text ?? "Loading thread";

  useLayoutEffect(() => {
    if (isActive && takeFocusHandoff(paneId, threadId)) {
      buttonRef.current?.focus({ preventScroll: true });
    }
  }, [isActive, paneId, threadId]);

  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-busy={metadata.kind === "loading" || undefined}
      tabIndex={isFocusable ? 0 : -1}
      title={
        statusLabel === null
          ? accessibleText
          : `${accessibleText} · ${statusLabel}`
      }
      data-thread-group-tab={threadId}
      onClick={onSelect}
      onPointerDown={
        onBeginPaneDrag
          ? (event) => {
              if (event.button === 0) onBeginPaneDrag(event, accessibleText);
            }
          : undefined
      }
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm font-normal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:h-9",
        isPinned ? "shrink overflow-hidden" : "shrink-0",
        metadata.kind === "unavailable" && "italic",
        isActive
          ? cn(
              "text-foreground",
              isPaneFocused
                ? CONTEXT_SELECTION_SURFACE_CLASS
                : "bg-state-hover",
              onBeginPaneDrag && "cursor-grab touch-none select-none",
            )
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {text === null ? (
        <>
          <Skeleton aria-hidden className="h-3 w-16 min-w-0 shrink" />
          <span className="sr-only">{accessibleText}</span>
        </>
      ) : (
        <span className="max-w-48 min-w-0 truncate">{text}</span>
      )}
      {thread?.archived === true ? (
        <Icon
          aria-hidden
          name="Archive"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : statusState === null || statusLabel === null ? null : (
        <span
          aria-hidden
          className="inline-flex size-3.5 shrink-0 items-center justify-center"
        >
          <ThreadStatusGlyph
            {...statusState}
            pluginStatus={pluginStatus}
            size="compact"
          />
        </span>
      )}
      {statusLabel === null ? null : (
        <span className="sr-only">, {statusLabel}</span>
      )}
    </button>
  );
}

function CreateThreadButton({
  action,
  onCreated,
}: {
  action: ExperimentalThreadGroupCreateAction;
  onCreated: (threadId: string, keepFocus: boolean) => void;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const handleCreate = async (fromKeyboard: boolean) => {
    setIsCreating(true);
    try {
      const threadId = await action.onCreate();
      if (typeof threadId === "string" && threadId.length > 0) {
        onCreated(threadId, fromKeyboard);
      }
    } catch (error) {
      appToast.error(
        `${action.label} failed`,
        error instanceof Error ? { description: error.message } : undefined,
      );
    } finally {
      setIsCreating(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={action.label}
          disabled={isCreating}
          data-thread-group-create=""
          className={cn(
            HEADER_ICON_BUTTON_CLASS,
            CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
            "shrink-0",
          )}
          onClick={(event) => void handleCreate(event.detail === 0)}
        >
          <Icon
            name={isCreating ? "Loading" : "Plus"}
            className={cn(
              isCreating && "animate-spin motion-reduce:animate-none",
            )}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{action.label}</TooltipContent>
    </Tooltip>
  );
}
