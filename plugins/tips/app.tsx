import { useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { detectTipClient, readTipClientEnvironment } from "./client.js";
import type { TipView, tipsRpcContract } from "./contract.js";

const TIPS_CHANGED_CHANNEL = "tips-changed";

function TipsHomepageSection() {
  const rpc = useRpc<typeof tipsRpcContract>();
  const navigate = useBbNavigate();
  const settings = useSettings();
  const enabled = settings.values?.enabled !== false;
  const [tip, setTip] = useState<TipView | null>(null);
  const [revision, setRevision] = useState(0);

  useRealtime(TIPS_CHANGED_CHANNEL, () => {
    setRevision((current) => current + 1);
  });

  useEffect(() => {
    if (!enabled) {
      setTip(null);
      return;
    }
    let active = true;
    rpc
      .call("current", { client: detectTipClient(readTipClientEnvironment()) })
      .then(
        (result) => {
          if (active) setTip(result.tip);
        },
        () => {
          if (active) setTip(null);
        },
      );
    return () => {
      active = false;
    };
  }, [enabled, revision, rpc]);

  if (!enabled || tip === null) return null;

  const dismiss = () => {
    setTip(null);
    void rpc.call("dismiss", { id: tip.id }).catch(() => {});
  };

  const runAction = () => {
    const action = tip.action;
    if (action === null) return;
    if (action.kind === "prompt") {
      navigate.toCompose({ initialPrompt: action.prompt, focusPrompt: true });
    } else if (
      action.kind === "route"
        ? !navigate.experimental_openAppRoute(action.path)
        : !navigate.experimental_runAppCommand(action.commandId)
    ) {
      return;
    }
    setTip(null);
    void rpc.call("act", { id: tip.id }).catch(() => {});
  };

  return (
    <aside
      aria-label="Tip"
      data-tip-id={tip.id}
      className="flex items-start gap-3 rounded-lg border border-border/60 px-3.5 py-3"
    >
      <Icon
        name="Explore"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{tip.title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{tip.body}</p>
        {tip.action !== null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2.5"
            onClick={runAction}
          >
            {tip.action.label}
          </Button>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="-mr-1.5 -mt-1 size-7 shrink-0 text-muted-foreground"
        aria-label="Dismiss tip"
        onClick={dismiss}
      >
        <Icon name="X" className="size-3.5" aria-hidden />
      </Button>
    </aside>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "tips",
    component: TipsHomepageSection,
  });
});
