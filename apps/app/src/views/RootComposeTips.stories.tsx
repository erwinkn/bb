import { useState, type ComponentType, type ReactNode } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { StoryCard, StoryRow } from "../../.ladle/story-card";
import { StoryComposer } from "./mobile-home-story-fixtures";

export default { title: "views/New Thread Tips" };

type StoryTipAction =
  | { kind: "prompt"; label: string; prompt: string }
  | { kind: "route"; label: string; path: string }
  | { kind: "command"; label: string; commandId: string };

interface StoryTip {
  id: string;
  title: string;
  body: string;
  action: StoryTipAction;
}

interface GridProps {
  tips: readonly StoryTip[];
  previewId: string | null;
  filledId: string | null;
  task: string | null;
  onPreview(id: string | null): void;
  onActivate(tip: StoryTip): void;
}

interface HeaderProps {
  label: ReactNode;
  onMore(): void;
  onHide(): void;
  onTurnOff(): void;
}

interface GalleryModule {
  TipsGallery: ComponentType<
    GridProps &
      Omit<HeaderProps, "label"> & {
        notice: string | null;
      }
  >;
  TipsHeader: ComponentType<HeaderProps>;
  TipsGrid: ComponentType<GridProps>;
  TIPS_SECTION_CLASS: string;
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

function renderCatalog(ids: readonly string[]): StoryTip[] {
  return ids.flatMap((id) => {
    const definition = catalog.TIP_CATALOG.find((entry) => entry.id === id);
    return definition === undefined
      ? []
      : [catalog.renderTip(definition, STORY_SIGNALS)];
  });
}

const CARD_TIPS = renderCatalog([
  "subthreads",
  "set-up-for-me",
  "phone",
  "browser-automation",
  "build-plugin",
  "account-pool",
]);

const WRITTEN_TIPS = renderCatalog([
  "command-palette",
  "queue-or-steer",
  "thread-search",
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
  written: StoryTip | undefined;
  previewId: string | null;
  filledId: string | null;
  task: string | null;
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
  const filled = draft.trim() === "" ? null : filledId;
  const state: TipsPageState = {
    tips,
    written: WRITTEN_TIPS[page % WRITTEN_TIPS.length],
    previewId,
    filledId: filled,
    task: draft.trim() === "" ? null : draft.trim(),
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

function WrittenTip({ tip }: { tip: StoryTip | undefined }) {
  if (tip === undefined) return null;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon name="Explore" className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">Tip: {tip.body}</span>
    </p>
  );
}

function Grid({ state }: { state: TipsPageState }) {
  return (
    <gallery.TipsGrid
      tips={state.tips}
      previewId={state.previewId}
      filledId={state.filledId}
      task={state.task}
      onPreview={state.setPreviewId}
      onActivate={state.activate}
    />
  );
}

function Status({ state }: { state: TipsPageState }) {
  return (
    <p role="status" className="min-h-4 text-xs text-muted-foreground">
      {state.notice ?? ""}
    </p>
  );
}

function header(state: TipsPageState, label: ReactNode) {
  return (
    <gallery.TipsHeader
      label={label}
      onMore={state.more}
      onHide={() => {}}
      onTurnOff={() => {}}
    />
  );
}

const TRY_WITH_BB = (
  <h2 className="text-xs font-medium text-muted-foreground">Try with bb</h2>
);

function ControlLayout(state: TipsPageState) {
  return (
    <gallery.TipsGallery
      tips={state.tips}
      previewId={state.previewId}
      filledId={state.filledId}
      task={state.task}
      notice={state.notice}
      onPreview={state.setPreviewId}
      onActivate={state.activate}
      onMore={state.more}
      onHide={() => {}}
      onTurnOff={() => {}}
    />
  );
}

function StripAboveLayout(state: TipsPageState) {
  return (
    <section aria-label="Ideas to try" className={gallery.TIPS_SECTION_CLASS}>
      <WrittenTip tip={state.written} />
      {header(state, TRY_WITH_BB)}
      <Grid state={state} />
      <Status state={state} />
    </section>
  );
}

function StripAsHeaderLayout(state: TipsPageState) {
  return (
    <section aria-label="Ideas to try" className={gallery.TIPS_SECTION_CLASS}>
      {header(state, <WrittenTip tip={state.written} />)}
      <Grid state={state} />
      <Status state={state} />
    </section>
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

export function Control() {
  return (
    <LayoutStory
      layout={ControlLayout}
      hint="Production layout: three label-free tiles under the composer. Hover a prompt tile to preview its prompt as the placeholder; click to fill the composer."
    />
  );
}
Control.storyName = "Control (production)";

export function WrittenTipAbove() {
  return (
    <LayoutStory
      layout={StripAboveLayout}
      hint="A: one quiet written tip (shortcuts and small behaviors) above the Try with bb header."
    />
  );
}
WrittenTipAbove.storyName = "A Written tip above header";

export function WrittenTipAsHeader() {
  return (
    <LayoutStory
      layout={StripAsHeaderLayout}
      hint="B: the written tip replaces the Try with bb label; More ideas and the menu stay on the right."
    />
  );
}
WrittenTipAsHeader.storyName = "B Written tip as header";
