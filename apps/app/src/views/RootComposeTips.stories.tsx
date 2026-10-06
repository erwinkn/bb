import { useState, type ComponentType, type ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
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
  TipsFooter: ComponentType<ControlsProps>;
  TipCardText: ComponentType<{ tip: StoryTip }>;
  TIP_CARD_CLASS: string;
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

function BorderlessLayout(state: TipsPageState) {
  return (
    <section aria-label="Tips" className={gallery.TIPS_SECTION_CLASS}>
      <ul className="grid grid-cols-3 divide-x divide-border-hairline">
        {state.tips.map((tip) => (
          <li key={tip.id} className="px-1.5">
            <button
              type="button"
              data-tip-id={tip.id}
              className={cn(
                gallery.TIP_CARD_CLASS,
                state.filledId === tip.id && "bg-surface-selected",
              )}
              onMouseEnter={() => state.setPreviewId(tip.id)}
              onMouseLeave={() => state.setPreviewId(null)}
              onFocus={() => state.setPreviewId(tip.id)}
              onBlur={() => state.setPreviewId(null)}
              onClick={() => state.activate(tip)}
            >
              <gallery.TipCardText tip={tip} />
            </button>
          </li>
        ))}
      </ul>
      <gallery.TipsFooter
        notice={state.notice}
        onMore={state.more}
        onHide={() => {}}
        onTurnOff={() => {}}
      />
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
      hint="Production layout: three bordered text-only cards under the composer, with the status line, More ideas, and the menu in a slim row below them. Hover a prompt card to preview its prompt as the placeholder; click to fill the composer."
    />
  );
}
Control.storyName = "Control (production)";

export function TextOnlyBorderless() {
  return (
    <LayoutStory
      layout={BorderlessLayout}
      hint="Exploration: the same text-only cards with no border or background at rest, hairline dividers between columns, and a fill only on hover or focus."
    />
  );
}
TextOnlyBorderless.storyName = "Text-only borderless";
