import { useRef, useState } from "react";
import { isBackgroundAgentTaskType } from "@bb/domain";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import { useResizeObserver } from "usehooks-ts";
import { AnimatedDisclosureBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import { LiveDurationText } from "@/components/thread/timeline/LiveDurationText";
import { Icon } from "@bb/shared-ui/icon";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
} from "@bb/shared-ui/activity-row-styles";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  PromptStackCountSlot,
  PromptStackHoverChevron,
  useDisclosureFocusHandoff,
} from "@bb/shared-ui/prompt-stack-disclosure";

const BODY_ID = "thread-background-commands-card-body";
const TOGGLE_ID = "thread-background-commands-card-toggle";
const COMPACT_PROMPT_SHELL_MAX_WIDTH_REM = 34;
const DEFAULT_ROOT_FONT_SIZE_PX = 16;

function isCompactPromptShellWidth(width: number): boolean {
  const parsedRootFontSize =
    typeof window === "undefined"
      ? Number.NaN
      : Number.parseFloat(
          window.getComputedStyle(document.documentElement).fontSize,
        );
  const rootFontSize = Number.isFinite(parsedRootFontSize)
    ? parsedRootFontSize
    : DEFAULT_ROOT_FONT_SIZE_PX;
  return width <= COMPACT_PROMPT_SHELL_MAX_WIDTH_REM * rootFontSize;
}

interface BackgroundActivityDisplay {
  icon: "Terminal" | "UserRoundPlus";
  label: string;
  runningPrefix: string;
}

function backgroundActivityDisplay(
  row: TimelineWorkflowWorkRow,
): BackgroundActivityDisplay {
  if (isBackgroundAgentTaskType(row.taskType)) {
    return {
      icon: "UserRoundPlus",
      label: "Background agent",
      runningPrefix: "Running background agent:",
    };
  }
  return {
    icon: "Terminal",
    label: "Background command",
    runningPrefix: "Running background command:",
  };
}

function backgroundActivityGroupLabel(
  rows: readonly TimelineWorkflowWorkRow[],
): string {
  const hasAgent = rows.some((row) => isBackgroundAgentTaskType(row.taskType));
  const hasCommand = rows.some(
    (row) => !isBackgroundAgentTaskType(row.taskType),
  );
  if (hasAgent && hasCommand) {
    return "Background activity";
  }
  return hasAgent ? "Background agents" : "Background commands";
}

function backgroundActivityModel(row: TimelineWorkflowWorkRow): string | null {
  return isBackgroundAgentTaskType(row.taskType) ? row.model : null;
}

function backgroundActivityAriaLabel(
  row: TimelineWorkflowWorkRow,
  label = backgroundActivityDisplay(row).label,
): string {
  const model = backgroundActivityModel(row);
  return model
    ? `${label}: ${row.description} · Model ${model}`
    : `${label}: ${row.description}`;
}

function compactBackgroundActivityLabel(
  rows: readonly TimelineWorkflowWorkRow[],
): string {
  const agentCount = rows.filter((row) =>
    isBackgroundAgentTaskType(row.taskType),
  ).length;
  const commandCount = rows.length - agentCount;
  if (commandCount === 0) {
    return `Running ${agentCount} background agent${agentCount === 1 ? "" : "s"}`;
  }
  if (agentCount === 0) {
    return `Running ${commandCount} background command${commandCount === 1 ? "" : "s"}`;
  }
  return `Running ${rows.length} background activities`;
}

function BackgroundActivitySummary({
  row,
  showDuration,
}: {
  row: TimelineWorkflowWorkRow;
  showDuration: boolean;
}) {
  const display = backgroundActivityDisplay(row);
  const model = backgroundActivityModel(row);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 text-left">
      <span
        className={cn(
          "shrink-0 whitespace-nowrap",
          activityMetaClass("active"),
        )}
      >
        {display.runningPrefix}
      </span>
      <span
        className={cn("min-w-0 truncate", activityTextClass("active"))}
        title={row.description}
      >
        {row.description}
      </span>
      {model ? (
        <span
          className={cn(
            "shrink-0 whitespace-nowrap font-mono text-2xs",
            activityMetaClass("active"),
          )}
          title={`Model: ${model}`}
        >
          {model}
        </span>
      ) : null}
      {showDuration ? (
        <span
          className={cn("shrink-0 tabular-nums", activityMetaClass("active"))}
        >
          <LiveDurationText startedAt={row.startedAt} />
        </span>
      ) : null}
    </span>
  );
}

type BackgroundTaskStopState =
  | { kind: "stopping" }
  | { kind: "failed"; message: string };

function stopFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Request failed.";
}

function formatStartedAt(startedAt: number): string {
  return new Date(startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function BackgroundActivityRow({
  row,
  isCardExpanded,
  isCompact,
  stopState,
  onStop,
}: {
  row: TimelineWorkflowWorkRow;
  isCardExpanded: boolean;
  isCompact: boolean;
  stopState: BackgroundTaskStopState | undefined;
  onStop: (() => void) | undefined;
}) {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const display = backgroundActivityDisplay(row);
  const model = backgroundActivityModel(row);
  const detailsId = `${BODY_ID}-${row.id}-details`;
  return (
    <li className="flex min-w-0 flex-col">
      <div
        className={cn(
          "flex min-w-0 gap-1.5 px-3 py-0.5 text-xs",
          isCompact ? "items-start" : "items-center",
        )}
      >
        <button
          type="button"
          aria-expanded={isDetailsOpen}
          aria-controls={detailsId}
          aria-label={backgroundActivityAriaLabel(row)}
          onClick={() => setIsDetailsOpen((value) => !value)}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer gap-1.5 rounded-sm text-left hover:text-foreground",
            isCompact ? "items-start" : "items-center",
          )}
        >
          <span className="flex h-[1lh] shrink-0 items-center">
            <Icon
              name={display.icon}
              className="size-3.5 text-muted-foreground/60"
              aria-hidden="true"
            />
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 text-muted-foreground",
              isCompact ? "line-clamp-2 break-all" : "truncate",
            )}
            title={row.description}
          >
            {row.description}
          </span>
          {model ? (
            <span
              className="shrink-0 whitespace-nowrap font-mono text-2xs text-subtle-foreground"
              title={`Model: ${model}`}
            >
              {model}
            </span>
          ) : null}
          <span className="shrink-0 whitespace-nowrap tabular-nums text-subtle-foreground">
            {isCardExpanded ? (
              <LiveDurationText startedAt={row.startedAt} />
            ) : null}
          </span>
        </button>
        {onStop ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopState?.kind === "stopping"}
            aria-label={`Stop ${display.label.toLowerCase()}: ${row.description}`}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait disabled:text-muted-foreground/60"
          >
            <Icon
              name={stopState?.kind === "stopping" ? "Loading" : "Square"}
              className={cn(
                "size-3",
                stopState?.kind === "stopping" && "animate-spin",
              )}
              aria-hidden="true"
            />
            {stopState?.kind === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </div>
      {stopState?.kind === "failed" ? (
        <p role="alert" className="px-3 pl-8 text-2xs text-destructive">
          Could not stop: {stopState.message}
        </p>
      ) : null}
      {isDetailsOpen ? (
        <div
          id={detailsId}
          className="mx-3 mb-1 ml-8 flex min-w-0 flex-col gap-1 text-2xs text-muted-foreground"
        >
          {row.command ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/60 px-2 py-1 font-mono text-2xs text-foreground [overflow-wrap:anywhere]">
              {row.command}
            </pre>
          ) : (
            <p className="whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">
              {row.description}
            </p>
          )}
          <span className="tabular-nums">
            Started {formatStartedAt(row.startedAt)}
          </span>
        </div>
      ) : null}
    </li>
  );
}

interface ThreadBackgroundCommandsCardProps {
  commands: TimelineWorkflowWorkRow[];
  isExpanded: boolean;
  onToggle: () => void;
  onStop?: ((row: TimelineWorkflowWorkRow) => Promise<void>) | undefined;
}

export function ThreadBackgroundCommandsCard({
  commands,
  isExpanded,
  onToggle,
  onStop,
}: ThreadBackgroundCommandsCardProps) {
  const isCompactViewport = useIsCompactViewport();
  const cardRef = useRef<HTMLElement>(null!);
  const [isCompactCard, setIsCompactCard] = useState<boolean | null>(null);
  const [stopStates, setStopStates] = useState<
    ReadonlyMap<string, BackgroundTaskStopState>
  >(() => new Map());
  const focus = useDisclosureFocusHandoff(isExpanded, onToggle);
  useResizeObserver({
    ref: cardRef,
    box: "border-box",
    onResize: ({ width }) => {
      if (width === undefined) return;
      const nextIsCompact = isCompactPromptShellWidth(width);
      setIsCompactCard((previous) =>
        previous === nextIsCompact ? previous : nextIsCompact,
      );
    },
  });
  const primary = commands[0];
  if (!primary) {
    return null;
  }
  const others = commands.slice(1);
  const hasMore = others.length > 0;
  const useCompactSummary = isCompactCard ?? isCompactViewport;
  const showsGroupSummary = useCompactSummary || isExpanded;
  const compactLabel = compactBackgroundActivityLabel(commands);
  const primaryDisplay = backgroundActivityDisplay(primary);
  const groupLabel = backgroundActivityGroupLabel(commands);
  const setStopState = (
    itemId: string,
    state: BackgroundTaskStopState,
  ): void => {
    setStopStates((previous) => new Map(previous).set(itemId, state));
  };
  const stopRow = (row: TimelineWorkflowWorkRow): void => {
    if (!onStop) return;
    setStopState(row.itemId, { kind: "stopping" });
    onStop(row).catch((error: unknown) => {
      setStopState(row.itemId, {
        kind: "failed",
        message: stopFailureMessage(error),
      });
    });
  };

  return (
    <PromptStackCard
      rootRef={cardRef}
      ariaLabel={groupLabel}
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={TOGGLE_ID}
          aria-expanded={isExpanded}
          aria-controls={BODY_ID}
          aria-label={
            showsGroupSummary
              ? compactLabel
              : hasMore
                ? backgroundActivityAriaLabel(primary, groupLabel)
                : backgroundActivityAriaLabel(primary)
          }
          ref={focus.triggerRef}
          onClick={focus.onTriggerClick}
          className={activityRowClass(
            "active",
            cn(
              PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
              PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
            ),
          )}
        >
          <Icon
            name={primaryDisplay.icon}
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden="true"
          />
          {showsGroupSummary ? (
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {compactLabel}
            </span>
          ) : (
            <BackgroundActivitySummary row={primary} showDuration={!hasMore} />
          )}
          {!showsGroupSummary && hasMore ? (
            <PromptStackCountSlot count={others.length} />
          ) : (
            <PromptStackHoverChevron isExpanded={isExpanded} />
          )}
        </button>
      </div>
      <AnimatedDisclosureBody
        id={BODY_ID}
        labelledBy={TOGGLE_ID}
        isExpanded={isExpanded}
        collapsedBorder="none"
        collapseLabel={`Collapse ${groupLabel.toLowerCase()}`}
        collapseRef={focus.collapseRef}
        onCollapse={focus.onCollapseClick}
      >
        <ul className="flex flex-col gap-0.5 py-1">
          {commands.map((row) => (
            <BackgroundActivityRow
              key={row.id}
              row={row}
              isCardExpanded={isExpanded}
              isCompact={useCompactSummary}
              stopState={stopStates.get(row.itemId)}
              onStop={onStop ? () => stopRow(row) : undefined}
            />
          ))}
        </ul>
      </AnimatedDisclosureBody>
    </PromptStackCard>
  );
}
