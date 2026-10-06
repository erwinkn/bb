import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  definePluginApp,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRpc,
  useSettings,
  type PluginHomepageSectionProps,
} from "@get-bb/plugin-sdk/app";
import { detectTipClient, readTipClientEnvironment } from "./client.js";
import { composeTipDraft } from "./compose.js";
import type { TipView, tipsRpcContract } from "./contract.js";
import { TipsGallery, TipsHiddenNotice } from "./gallery.js";

const TIPS_CHANGED_CHANNEL = "tips-changed";
const COMPACT_LAYOUT_QUERY = "(max-width: 767px)";
const MIN_GALLERY_WIDTH = 520;

function subscribeCompactLayout(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(COMPACT_LAYOUT_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function isCompactLayout(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}

function useCompactLayout(): boolean {
  return useSyncExternalStore(
    subscribeCompactLayout,
    isCompactLayout,
    isCompactLayout,
  );
}

function useElementWidth(): [(element: HTMLDivElement | null) => void, number] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      setWidth(element.getBoundingClientRect().width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

function promptOf(tip: TipView | undefined): string | null {
  return tip?.action.kind === "prompt" ? tip.action.prompt : null;
}

function TipsGallerySection({
  projectId,
  client,
}: {
  projectId: string | null;
  client: ReturnType<typeof detectTipClient>;
}) {
  const rpc = useRpc<typeof tipsRpcContract>();
  const navigate = useBbNavigate();
  const composer = useComposer();
  const settings = useSettings();
  const enabled = settings.values?.enabled !== false;
  const [tips, setTips] = useState<readonly TipView[]>([]);
  const [revision, setRevision] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [filledId, setFilledId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const isEmpty = composer.isEmpty;

  useRealtime(TIPS_CHANGED_CHANNEL, () => {
    setRevision((current) => current + 1);
  });

  useEffect(() => {
    if (!enabled) {
      setTips([]);
      return;
    }
    let active = true;
    rpc.call("current", { client, projectId }).then(
      (result) => {
        if (active) setTips(result.tips);
      },
      () => {
        if (active) setTips([]);
      },
    );
    return () => {
      active = false;
    };
  }, [client, enabled, projectId, revision, rpc]);

  const preview = promptOf(tips.find((tip) => tip.id === previewId));
  useEffect(() => {
    composer.experimental_setPlaceholderPreview(
      isEmpty && preview !== null ? preview.trimEnd() : null,
    );
  }, [composer, isEmpty, preview]);

  const filled = isEmpty ? null : filledId;

  const activate = useCallback(
    (tip: TipView) => {
      const action = tip.action;
      if (action.kind === "prompt") {
        composer.replace((current) => composeTipDraft(action.prompt, current));
        composer.focus();
        setPreviewId(null);
        setFilledId(tip.id);
        setNotice(`Added “${tip.title}” to the composer`);
      } else if (
        action.kind === "route"
          ? !navigate.experimental_openAppRoute(action.path)
          : !navigate.experimental_runAppCommand(action.commandId)
      ) {
        return;
      }
      void rpc.call("act", { id: tip.id }).catch(() => {});
    },
    [composer, navigate, rpc],
  );

  const turnOff = useCallback(() => {
    setDismissed(true);
    setPreviewId(null);
    void rpc.call("setEnabled", { enabled: false }).catch(() => {});
  }, [rpc]);

  const undo = useCallback(() => {
    setDismissed(false);
    void rpc.call("setEnabled", { enabled: true }).catch(() => {});
  }, [rpc]);

  if (dismissed) return <TipsHiddenNotice onUndo={undo} />;
  if (!enabled || tips.length === 0) return null;
  return (
    <TipsGallery
      tips={tips}
      filledId={filled}
      notice={notice}
      onPreview={setPreviewId}
      onActivate={activate}
      onDismiss={turnOff}
    />
  );
}

function TipsHomepageSection({ projectId }: PluginHomepageSectionProps) {
  const client = useMemo(() => detectTipClient(readTipClientEnvironment()), []);
  const onPhone =
    client.surface === "mobile-app" || client.surface === "mobile-web";
  const compact = useCompactLayout();
  const [measure, width] = useElementWidth();
  const fits = width >= MIN_GALLERY_WIDTH;
  if (onPhone) return null;
  return (
    <div ref={measure} data-tips-section="">
      {!compact && fits ? (
        <TipsGallerySection projectId={projectId} client={client} />
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "tips",
    component: TipsHomepageSection,
  });
});
