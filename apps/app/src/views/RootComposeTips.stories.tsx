import { useState, type ComponentType, type ReactNode } from "react";
import { StoryCard, StoryRow } from "../../.ladle/story-card";
import { StoryComposer } from "./mobile-home-story-fixtures";

export default { title: "views/New Thread Tips" };

type StoryTipAction =
  | { kind: "prompt"; label: string; prompt: string }
  | { kind: "route"; label: string; path: string }
  | { kind: "command"; label: string; commandId: string };

interface StoryTip {
  id: string;
  tone: string;
  title: string;
  body: string;
  action: StoryTipAction;
}

interface ControlsProps {
  notice: string | null;
  onDismiss(): void;
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

interface ArtModule {
  TipArt: ComponentType<{ tipId: string; tone: string }>;
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
const art = only(
  import.meta.glob<ArtModule>("../../../../plugins/tips/tip-art.tsx", {
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

const CARD_TIPS = ["subthreads", "set-up-for-me", "phone"].flatMap((id) => {
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
}

function NewThreadPage({
  children,
}: {
  children: (state: TipsPageState) => ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [filledId, setFilledId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | undefined>();
  const tips = CARD_TIPS;
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
      onDismiss={() => {}}
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

export function Control() {
  return (
    <LayoutStory
      layout={ControlLayout}
      hint="Production layout: a calm feed of three tips under the composer, each row an illustration with a title and body, with Hide tips above it. Hover a prompt row to preview its prompt as the placeholder; click to fill the composer."
    />
  );
}
Control.storyName = "Control (production)";

const ALL_TIPS = catalog.TIP_CATALOG.map((definition) =>
  catalog.renderTip(definition, STORY_SIGNALS),
);

export function Illustrations() {
  return (
    <StoryCard labelWidth="160px">
      <StoryRow
        label="every tip"
        hint="The static illustration each catalog tip shows at the start of its row, in catalog order."
      >
        <div className="grid w-[760px] grid-cols-5 gap-x-4 gap-y-6 rounded-xl border border-border bg-background p-6">
          {ALL_TIPS.map((tip) => (
            <div key={tip.id} className="flex flex-col gap-1">
              <art.TipArt tipId={tip.id} tone={tip.tone} />
              <span className="text-xs font-medium text-foreground">
                {tip.title}
              </span>
            </div>
          ))}
        </div>
      </StoryRow>
    </StoryCard>
  );
}
