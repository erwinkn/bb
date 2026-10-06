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

function TipAffordance({ tip, filled }: { tip: TipView; filled: boolean }) {
  if (filled) {
    return (
      <span className="mt-auto inline-flex items-center gap-1 pt-1 text-xs text-muted-foreground">
        <Icon name="Check" className="size-3" aria-hidden />
        In composer
      </span>
    );
  }
  if (tip.action.kind === "prompt") {
    return (
      <span className="mt-auto pt-1 text-xs text-muted-foreground">
        Adds prompt
      </span>
    );
  }
  return (
    <span className="mt-auto inline-flex items-center gap-0.5 pt-1 text-xs text-muted-foreground">
      {tip.action.label}
      <Icon name="ChevronRight" className="size-3" aria-hidden />
    </span>
  );
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
    <section aria-label="Ideas to try" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-muted-foreground">
          Try with bb
        </h2>
        <div className="flex items-center">
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
                  filled &&
                    "border-surface-selected-border bg-surface-selected",
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
                  className="h-28 w-full border-b border-border-hairline"
                />
                <span className="flex flex-1 flex-col gap-1 px-3 pb-3 pt-2.5">
                  <span className="text-sm font-medium text-foreground">
                    {tip.title}
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {tip.body}
                  </span>
                  <TipAffordance tip={tip} filled={filled} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
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
    <p role="status" className="text-xs text-muted-foreground">
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
