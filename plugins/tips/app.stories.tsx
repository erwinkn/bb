import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { TIP_CATALOG, renderTip, type TipSignals } from "./catalog.js";
import { composeTipDraft, taskFromDraft } from "./compose.js";
import type { TipView } from "./contract.js";
import { TipsGallery, TipsHiddenNotice } from "./gallery.js";

export default { title: "plugins/Tips" };

const STORY_SIGNALS: TipSignals = {
  client: { surface: "desktop", os: "macos" },
  projectId: null,
  serverPlatform: "darwin",
  appVersion: "0.42.0",
  firstSeenVersion: "0.41.0",
  daysSinceFirstSeen: 30,
  threadCount: 80,
  availableProviderCount: 2,
  providersUsed: ["claude-code"],
  installedPlugins: {},
  hasFinishedThread: true,
  finishedThreadCount: 40,
  hasChildThread: false,
  hasAutomationThread: false,
  projectHasChildThread: false,
  projectHasAutomationThread: false,
  waitingThreadCount: 3,
  rateLimited: true,
  recentlyRateLimited: true,
  queuedFollowUp: false,
  usedMobileApp: false,
};

const ALL_TIPS: readonly TipView[] = TIP_CATALOG.map((definition) =>
  renderTip(definition, STORY_SIGNALS),
);

function promptOf(tip: TipView | undefined): string | null {
  return tip?.action.kind === "prompt" ? tip.action.prompt : null;
}

function NewThreadPage({ start = 0 }: { start?: number }) {
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState(start);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [filledId, setFilledId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const pageCount = Math.ceil(ALL_TIPS.length / 3);
  const offset = (page % pageCount) * 3;
  const tips = ALL_TIPS.slice(offset, offset + 3);
  const preview = promptOf(tips.find((tip) => tip.id === previewId));
  const filled = draft.trim() === "" ? null : filledId;
  const task = taskFromDraft(
    draft,
    promptOf(tips.find((tip) => tip.id === filled)),
  );
  return (
    <div className="flex w-[760px] flex-col gap-6 rounded-xl border border-border bg-background p-4">
      <Textarea
        aria-label="Composer"
        className="min-h-24"
        value={draft}
        placeholder={
          draft === "" && preview !== null
            ? preview.trimEnd()
            : "Ask anything. @ to mention files, folders, or sections"
        }
        onChange={(event) => setDraft(event.target.value)}
      />
      {hidden !== null ? (
        <TipsHiddenNotice message={hidden} onUndo={() => setHidden(null)} />
      ) : (
        <TipsGallery
          tips={tips}
          previewId={previewId}
          filledId={filled}
          task={task === "" ? null : task}
          notice={notice}
          onPreview={setPreviewId}
          onActivate={(tip) => {
            const action = tip.action;
            if (action.kind === "prompt") {
              setDraft(
                (current) =>
                  composeTipDraft(action.prompt, {
                    text: current,
                    mentions: [],
                    attachments: [],
                  }).text,
              );
              setFilledId(tip.id);
              setNotice(`Added “${tip.title}” to the composer`);
            } else {
              setNotice(`Opens ${action.label}`);
            }
          }}
          onMore={() => {
            setPage((current) => current + 1);
            setPreviewId(null);
          }}
          onHide={() => setHidden("Tips hidden for today.")}
          onTurnOff={() => setHidden("Tips turned off.")}
        />
      )}
    </div>
  );
}

export function Gallery() {
  return <NewThreadPage />;
}

export function EveryScene() {
  return (
    <div className="flex flex-col gap-6">
      {Array.from({ length: Math.ceil(ALL_TIPS.length / 3) }, (_, page) => (
        <NewThreadPage key={page} start={page} />
      ))}
    </div>
  );
}
