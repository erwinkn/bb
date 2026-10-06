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

export interface TipsGalleryProps {
  tips: readonly TipView[];
  filledId: string | null;
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

function TipsFooter({
  notice,
  onMore,
  onHide,
  onTurnOff,
}: Pick<TipsGalleryProps, "notice" | "onMore" | "onHide" | "onTurnOff">) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p
        role="status"
        className="min-w-0 truncate text-xs text-muted-foreground"
      >
        {notice ?? ""}
      </p>
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

const TIP_CARD_CLASS =
  "flex h-full w-full flex-col gap-1 rounded-xl border border-border-hairline bg-surface-raised-solid px-4 pb-4 pt-3.5 text-left shadow-xs outline-none motion-safe:transition-shadow hover:shadow-sm focus-visible:shadow-sm focus-visible:ring-2 focus-visible:ring-ring";

function TipCardText({ tip }: { tip: TipView }) {
  return (
    <>
      <span
        aria-hidden
        className="mb-2 flex size-8 items-center justify-center rounded-lg bg-muted text-foreground"
      >
        <Icon name={tip.icon} className="size-4" />
      </span>
      <span className="text-sm font-medium text-foreground">{tip.title}</span>
      <span className="line-clamp-3 text-xs text-muted-foreground">
        {tip.body}
      </span>
      <span className="sr-only">{actionDescription(tip)}</span>
    </>
  );
}

export function TipsGrid({
  tips,
  filledId,
  onPreview,
  onActivate,
}: Pick<TipsGalleryProps, "tips" | "filledId" | "onPreview" | "onActivate">) {
  return (
    <ul className="grid grid-cols-3 gap-3">
      {tips.map((tip) => (
        <li key={tip.id}>
          <button
            type="button"
            data-tip-id={tip.id}
            className={cn(
              TIP_CARD_CLASS,
              filledId === tip.id &&
                "border-surface-selected-border bg-surface-selected",
            )}
            onMouseEnter={() => onPreview(tip.id)}
            onMouseLeave={() => onPreview(null)}
            onFocus={() => onPreview(tip.id)}
            onBlur={() => onPreview(null)}
            onClick={() => onActivate(tip)}
          >
            <TipCardText tip={tip} />
          </button>
        </li>
      ))}
    </ul>
  );
}

const TIPS_SECTION_CLASS = "mt-28 flex flex-col gap-1.5";

export function TipsGallery({
  tips,
  filledId,
  notice,
  onPreview,
  onActivate,
  onMore,
  onHide,
  onTurnOff,
}: TipsGalleryProps) {
  return (
    <section aria-label="Tips" className={TIPS_SECTION_CLASS}>
      <TipsGrid
        tips={tips}
        filledId={filledId}
        onPreview={onPreview}
        onActivate={onActivate}
      />
      <TipsFooter
        notice={notice}
        onMore={onMore}
        onHide={onHide}
        onTurnOff={onTurnOff}
      />
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
    <p role="status" className="mt-28 text-xs text-muted-foreground">
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
