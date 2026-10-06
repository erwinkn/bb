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
import {
  DioramaStyles,
  TipDiorama,
  type DioramaVariant,
} from "./root-compose-tips-dioramas";

export default { title: "views/New Thread Tips" };

type StoryTipAction =
  | { kind: "prompt"; label: string; prompt: string }
  | { kind: "route"; label: string; path: string }
  | { kind: "command"; label: string; commandId: string };

interface StoryTip {
  id: string;
  icon: string;
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

function renderTips(ids: readonly string[]): StoryTip[] {
  return ids.flatMap((id) => {
    const definition = catalog.TIP_CATALOG.find((entry) => entry.id === id);
    return definition === undefined
      ? []
      : [catalog.renderTip(definition, STORY_SIGNALS)];
  });
}

const CARD_TIPS = renderTips([
  "subthreads",
  "set-up-for-me",
  "phone",
  "browser-automation",
  "build-plugin",
  "account-pool",
]);

const DIORAMA_TIPS = renderTips([
  "subthreads",
  "set-up-for-me",
  "phone",
  "open-threads-that-need-me",
  "morning-digest",
  "browser-automation",
]);

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
  catalogTips,
  children,
}: {
  catalogTips: readonly StoryTip[];
  children: (state: TipsPageState) => ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [filledId, setFilledId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | undefined>();
  const offset = (page % 2) * 3;
  const tips = catalogTips.slice(offset, offset + 3);
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

function dioramaLayout(variant: DioramaVariant) {
  return function DioramaLayout(state: TipsPageState) {
    return (
      <section aria-label="Tips" className="mt-28 flex flex-col gap-1.5">
        <DioramaStyles />
        <ul className="grid grid-cols-3 gap-3">
          {state.tips.map((tip) => (
            <li key={tip.id}>
              <button
                type="button"
                data-tip-id={tip.id}
                className={cn(
                  "group flex h-full w-full flex-col overflow-hidden rounded-xl border border-border-hairline bg-background text-left shadow-xs outline-none motion-safe:transition-[box-shadow,background-color] hover:bg-surface-raised hover:shadow-sm focus-visible:shadow-sm focus-visible:ring-2 focus-visible:ring-ring",
                  state.filledId === tip.id &&
                    "border-surface-selected-border bg-surface-selected",
                )}
                onMouseEnter={() => state.setPreviewId(tip.id)}
                onMouseLeave={() => state.setPreviewId(null)}
                onFocus={() => state.setPreviewId(tip.id)}
                onBlur={() => state.setPreviewId(null)}
                onClick={() => state.activate(tip)}
              >
                <TipDiorama tipId={tip.id} variant={variant} />
                <span className="flex flex-col gap-1 px-4 pb-4 pt-3">
                  <span className="text-sm font-medium text-foreground">
                    {tip.title}
                  </span>
                  <span className="line-clamp-3 text-xs text-muted-foreground">
                    {tip.body}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <StoryTipsFooter state={state} />
      </section>
    );
  };
}

function FloatingLayout(state: TipsPageState) {
  return (
    <section aria-label="Tips" className="mt-28 flex flex-col gap-1.5">
      <DioramaStyles />
      <ul className="grid grid-cols-3 gap-3">
        {state.tips.map((tip) => (
          <li key={tip.id}>
            <button
              type="button"
              data-tip-id={tip.id}
              className={cn(
                "group flex h-full w-full flex-col rounded-xl pb-3 text-left outline-none motion-safe:transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring",
                state.filledId === tip.id && "bg-surface-selected",
              )}
              onMouseEnter={() => state.setPreviewId(tip.id)}
              onMouseLeave={() => state.setPreviewId(null)}
              onFocus={() => state.setPreviewId(tip.id)}
              onBlur={() => state.setPreviewId(null)}
              onClick={() => state.activate(tip)}
            >
              <TipDiorama tipId={tip.id} variant="float" />
              <span className="flex flex-col gap-1 px-3 pt-2">
                <span className="text-sm font-medium text-foreground">
                  {tip.title}
                </span>
                <span className="line-clamp-3 text-xs text-muted-foreground">
                  {tip.body}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <StoryTipsFooter state={state} />
    </section>
  );
}

const PaperLayout = dioramaLayout("paper");
const GlossyLayout = dioramaLayout("glossy");

function LayoutStory({
  layout,
  hint,
  catalogTips = CARD_TIPS,
}: {
  layout: (state: TipsPageState) => ReactNode;
  hint: string;
  catalogTips?: readonly StoryTip[];
}) {
  return (
    <StoryCard labelWidth="160px">
      <StoryRow label="desktop · 1040 wide" hint={hint}>
        <NewThreadPage catalogTips={catalogTips}>{layout}</NewThreadPage>
      </StoryRow>
    </StoryCard>
  );
}

export function Control() {
  return (
    <LayoutStory
      layout={ControlLayout}
      hint="Production layout: three raised cards with an icon chip, title, and body under the composer, with the status line, More ideas, and the menu in a slim row below them. Hover a prompt card to preview its prompt as the placeholder; click to fill the composer."
    />
  );
}
Control.storyName = "Control (production)";

export function PaperDiorama() {
  return (
    <LayoutStory
      layout={PaperLayout}
      catalogTips={DIORAMA_TIPS}
      hint="Exploration A: each card's top is a cut-paper diorama on kraft card stock, with layered paper hills, slow idle motion, and gentle pointer parallax. Static under reduced motion. More ideas shows split panes, the morning digest, and Browser Automation."
    />
  );
}
PaperDiorama.storyName = "A Paper diorama";

export function GlossyDiorama() {
  return (
    <LayoutStory
      layout={GlossyLayout}
      catalogTips={DIORAMA_TIPS}
      hint="Exploration B: polished objects on a small lit stage with a breathing spotlight, specular highlights, slow idle motion, and gentle pointer parallax. Static under reduced motion."
    />
  );
}
GlossyDiorama.storyName = "B Glossy objects";

export function FloatingDioramas() {
  return (
    <LayoutStory
      layout={FloatingLayout}
      catalogTips={DIORAMA_TIPS}
      hint="Exploration C: no card chrome. Each tip is a small neutral object standing on the page with a soft contact shadow, title and body beneath; the whole column is the button. Objects are still at rest and play a short settle with light parallax only while that tip is hovered or focused; static under reduced motion."
    />
  );
}
FloatingDioramas.storyName = "C · Floating dioramas";
