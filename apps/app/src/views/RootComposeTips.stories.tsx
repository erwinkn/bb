import { useState, type ComponentType, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { StoryCard, StoryRow } from "../../.ladle/story-card";
import { StoryComposer } from "./mobile-home-story-fixtures";

export default { title: "views/New Thread Tips" };

type StoryTipAction =
  | { kind: "prompt"; label: string; prompt: string }
  | { kind: "route"; label: string; path: string }
  | { kind: "command"; label: string; commandId: string };

type StoryTipTone = "blue" | "green" | "amber" | "orange" | "rose";

interface StoryTip {
  id: string;
  icon: string;
  tone: StoryTipTone;
  title: string;
  body: string;
  action: StoryTipAction;
}

interface ControlsProps {
  notice: string | null;
  onMore(): void;
  onHide(): void;
  onTurnOff(): void;
}

interface GalleryModule {
  TipsGallery: ComponentType<
    ControlsProps & {
      tips: readonly StoryTip[];
      filledId: string | null;
      onPreview(id: string | null): void;
      onActivate(tip: StoryTip): void;
    }
  >;
}

interface CatalogModule {
  TIP_CATALOG: readonly { id: string }[];
  renderTip(definition: { id: string }, signals: object): StoryTip;
}

function only<T>(modules: Record<string, T>): T {
  const [module] = Object.values(modules);
  if (module === undefined) throw new Error("Tips plugin module not found");
  return module;
}

const gallery = only(
  import.meta.glob<GalleryModule>("../../../../plugins/tips/gallery.tsx", {
    eager: true,
  }),
);
const catalog = only(
  import.meta.glob<CatalogModule>("../../../../plugins/tips/catalog.ts", {
    eager: true,
  }),
);

const STORY_SIGNALS = {
  client: { surface: "desktop", os: "macos" },
  appVersion: "0.42.0",
};

const CARD_TIPS = [
  "subthreads",
  "set-up-for-me",
  "phone",
  "browser-automation",
  "build-plugin",
  "account-pool",
].flatMap((id) => {
  const definition = catalog.TIP_CATALOG.find((entry) => entry.id === id);
  return definition === undefined
    ? []
    : [catalog.renderTip(definition, STORY_SIGNALS)];
});

function composeTip(prompt: string, draft: string): string {
  const task = draft.trim();
  if (task === "") return prompt;
  return prompt.endsWith(" ")
    ? `${prompt}${task}`
    : `${draft.trimEnd()}\n\n${prompt}`;
}

interface TipsPageState {
  tips: readonly StoryTip[];
  filledId: string | null;
  notice: string | null;
  setPreviewId(id: string | null): void;
  activate(tip: StoryTip): void;
  more(): void;
}

function NewThreadPage({
  children,
}: {
  children: (state: TipsPageState) => ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [filledId, setFilledId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | undefined>();
  const offset = (page % 2) * 3;
  const tips = CARD_TIPS.slice(offset, offset + 3);
  const preview = tips.find((tip) => tip.id === previewId)?.action;
  const state: TipsPageState = {
    tips,
    filledId: draft.trim() === "" ? null : filledId,
    notice,
    setPreviewId,
    activate(tip) {
      const action = tip.action;
      if (action.kind !== "prompt") {
        setNotice(`Opens ${action.label}`);
        return;
      }
      setDraft((current) => composeTip(action.prompt, current));
      setFilledId(tip.id);
      setFocusRequest(`${tip.id}:${Date.now()}`);
      setNotice(`Added “${tip.title}” to the composer`);
    },
    more() {
      setPage((current) => current + 1);
      setPreviewId(null);
    },
  };
  return (
    <div className="@container/page flex h-[720px] w-[1040px] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col px-4 pb-4 pt-14">
          <StoryComposer
            id="story-tips-composer"
            mentionMenuPlacement="bottom"
            value={draft}
            onValueChange={setDraft}
            placeholder={
              draft === "" && preview?.kind === "prompt"
                ? preview.prompt.trimEnd()
                : undefined
            }
            focusRequest={focusRequest}
          />
          <div className="mt-6 space-y-6">{children(state)}</div>
        </div>
      </div>
    </div>
  );
}

function ControlLayout(state: TipsPageState) {
  return (
    <gallery.TipsGallery
      tips={state.tips}
      filledId={state.filledId}
      notice={state.notice}
      onPreview={state.setPreviewId}
      onActivate={state.activate}
      onMore={state.more}
      onHide={() => {}}
      onTurnOff={() => {}}
    />
  );
}

function LayoutStory({
  layout,
  hint,
}: {
  layout: (state: TipsPageState) => ReactNode;
  hint: string;
}) {
  return (
    <StoryCard labelWidth="160px">
      <StoryRow label="desktop · 1040 wide" hint={hint}>
        <NewThreadPage>{layout}</NewThreadPage>
      </StoryRow>
    </StoryCard>
  );
}

const TONE_COLOR: Record<StoryTipTone, string> = {
  blue: "var(--timeline-accent)",
  green: "var(--success)",
  amber: "var(--attention)",
  orange: "var(--warning)",
  rose: "color-mix(in oklab, var(--destructive) 55%, var(--timeline-accent))",
};

function StoryTipsFooter({ state }: { state: TipsPageState }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p
        role="status"
        className="min-w-0 truncate text-xs text-muted-foreground"
      >
        {state.notice ?? ""}
      </p>
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground"
          onClick={state.more}
        >
          More ideas
        </Button>
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
            <DropdownMenuItem>Hide tips for today</DropdownMenuItem>
            <DropdownMenuItem>Turn off tips</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function tintedLayout(wash: boolean) {
  return function TintedLayout(state: TipsPageState) {
    return (
      <section aria-label="Tips" className="mt-28 flex flex-col gap-1.5">
        <ul className="grid grid-cols-3 gap-3">
          {state.tips.map((tip) => {
            const tone = TONE_COLOR[tip.tone];
            return (
              <li key={tip.id}>
                <button
                  type="button"
                  data-tip-id={tip.id}
                  className={cn(
                    "group relative flex h-full w-full flex-col gap-1 overflow-hidden rounded-xl border border-border-hairline bg-background px-4 pb-4 pt-3.5 text-left shadow-xs outline-none motion-safe:transition-[box-shadow,background-color] hover:bg-surface-raised hover:shadow-sm focus-visible:bg-surface-raised focus-visible:shadow-sm focus-visible:ring-2 focus-visible:ring-ring",
                    state.filledId === tip.id &&
                      "border-surface-selected-border bg-surface-selected",
                  )}
                  onMouseEnter={() => state.setPreviewId(tip.id)}
                  onMouseLeave={() => state.setPreviewId(null)}
                  onFocus={() => state.setPreviewId(tip.id)}
                  onBlur={() => state.setPreviewId(null)}
                  onClick={() => state.activate(tip)}
                >
                  {wash ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 opacity-60 motion-safe:transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                      style={{
                        background: `radial-gradient(140% 110% at 0% 0%, color-mix(in oklab, ${tone} 10%, transparent), transparent 55%)`,
                      }}
                    />
                  ) : null}
                  <span
                    aria-hidden
                    className="relative mb-2 flex size-8 items-center justify-center rounded-lg"
                    style={{
                      background: `color-mix(in oklab, ${tone} 14%, transparent)`,
                      color: `color-mix(in oklab, ${tone} 45%, var(--ink))`,
                    }}
                  >
                    <Icon name={tip.icon} className="size-4" />
                  </span>
                  <span className="relative text-sm font-medium text-foreground">
                    {tip.title}
                  </span>
                  <span className="relative line-clamp-3 text-xs text-muted-foreground">
                    {tip.body}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <StoryTipsFooter state={state} />
      </section>
    );
  };
}

const TintedChipLayout = tintedLayout(false);
const TintedWashLayout = tintedLayout(true);

export function Control() {
  return (
    <LayoutStory
      layout={ControlLayout}
      hint="Production layout: three raised cards with a tinted icon chip, title, and body under the composer, with the status line, More ideas, and the menu in a slim row below them. Hover a prompt card to preview its prompt as the placeholder; click to fill the composer."
    />
  );
}
Control.storyName = "Control (production)";

export function TintedChips() {
  return (
    <LayoutStory
      layout={TintedChipLayout}
      hint="Candidate 1: each tip gets its own soft hue from the theme's accent tokens; the icon chip and icon are tinted to match. The card is otherwise unchanged."
    />
  );
}
TintedChips.storyName = "1 Tinted chips";

export function TintedChipsWithWash() {
  return (
    <LayoutStory
      layout={TintedWashLayout}
      hint="Candidate 2: the same tinted chip plus a very faint wash of that hue in the card's top-left corner, slightly stronger on hover or focus."
    />
  );
}
TintedChipsWithWash.storyName = "2 Tinted chip with wash";
