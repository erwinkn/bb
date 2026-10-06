import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { TipView } from "./contract.js";
import { TipGraphic } from "./scenes.js";

export interface TipsGalleryProps {
  tips: readonly TipView[];
  previewId: string | null;
  filledId: string | null;
  task: string | null;
  notice: string | null;
  onPreview(id: string | null): void;
  onActivate(tip: TipView): void;
  onMore(): void;
  onHide(): void;
  onTurnOff(): void;
}

function actionDescription(tip: TipView): string {
  switch (tip.action.kind) {
    case "prompt":
      return "Adds prompt to composer";
    case "route":
      return `Opens settings: ${tip.action.label}`;
    case "command":
      return tip.action.label;
  }
}

function TipsMenu({
  onHide,
  onTurnOff,
}: Pick<TipsGalleryProps, "onHide" | "onTurnOff">) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label="Tip options"
        >
          <Icon name="MoreHorizontal" className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onHide}>
          Hide tips for today
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onTurnOff}>Turn off tips</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TipsHeader({
  label,
  onMore,
  onHide,
  onTurnOff,
}: Pick<TipsGalleryProps, "onMore" | "onHide" | "onTurnOff"> & {
  label: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">{label}</div>
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground"
          onClick={onMore}
        >
          More ideas
        </Button>
        <TipsMenu onHide={onHide} onTurnOff={onTurnOff} />
      </div>
    </div>
  );
}

export function TipsGrid({
  tips,
  previewId,
  filledId,
  task,
  onPreview,
  onActivate,
}: Pick<
  TipsGalleryProps,
  "tips" | "previewId" | "filledId" | "task" | "onPreview" | "onActivate"
>) {
  return (
    <ul className="grid grid-cols-3 gap-3">
      {tips.map((tip) => {
        const filled = filledId === tip.id;
        return (
          <li key={tip.id}>
            <button
              type="button"
              data-tip-id={tip.id}
              className={cn(
                "flex h-full w-full flex-col overflow-hidden rounded-lg border border-border-hairline text-left outline-none",
                "hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring",
                filled && "border-surface-selected-border bg-surface-selected",
              )}
              onMouseEnter={() => onPreview(tip.id)}
              onMouseLeave={() => onPreview(null)}
              onFocus={() => onPreview(tip.id)}
              onBlur={() => onPreview(null)}
              onClick={() => onActivate(tip)}
            >
              <TipGraphic
                tipId={tip.id}
                active={previewId === tip.id || filled}
                task={task}
                className="h-24 w-full border-b border-border-hairline"
              />
              <span className="flex flex-col gap-0.5 px-3 pb-2.5 pt-2">
                <span className="text-sm font-medium text-foreground">
                  {tip.title}
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {tip.body}
                </span>
                <span className="sr-only">{actionDescription(tip)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export const TIPS_SECTION_CLASS = "mt-6 flex flex-col gap-3";

export function TipsGallery({
  tips,
  previewId,
  filledId,
  task,
  notice,
  onPreview,
  onActivate,
  onMore,
  onHide,
  onTurnOff,
}: TipsGalleryProps) {
  return (
    <section aria-label="Ideas to try" className={TIPS_SECTION_CLASS}>
      <TipsHeader
        label={
          <h2 className="text-xs font-medium text-muted-foreground">
            Try with bb
          </h2>
        }
        onMore={onMore}
        onHide={onHide}
        onTurnOff={onTurnOff}
      />
      <TipsGrid
        tips={tips}
        previewId={previewId}
        filledId={filledId}
        task={task}
        onPreview={onPreview}
        onActivate={onActivate}
      />
      <p role="status" className="min-h-4 text-xs text-muted-foreground">
        {notice ?? ""}
      </p>
    </section>
  );
}

export function TipsHiddenNotice({
  message,
  onUndo,
}: {
  message: string;
  onUndo: () => void;
}) {
  return (
    <p role="status" className="mt-6 text-xs text-muted-foreground">
      {message}{" "}
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground"
        onClick={onUndo}
      >
        Undo
      </button>
    </p>
  );
}
