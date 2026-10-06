import { useEffect, useState, type ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { CONTEXT_CARD_CLASS } from "@/components/ui/chrome-style-tokens";
import { PluginBrandIcon } from "@/components/ui/plugin-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DIRECTIVE_ID, PLUGIN_ID_PATTERN } from "./shared.js";
import type {
  PluginCard,
  PluginCardSource,
  pluginCardsRpcContract,
} from "./server.js";

type CardState =
  | { status: "loading" }
  | { status: "ready"; card: PluginCard }
  | { status: "not-found" }
  | { status: "error"; message: string };

export function pluginCardStatus(card: PluginCard): string {
  if (card.installed) return card.enabled ? "Enabled" : "Disabled";
  return card.compatible ? "Not installed" : "Incompatible";
}

export function pluginCardActionLabel(card: PluginCard): string {
  if (!card.installed) return "Install";
  return card.enabled ? "Open" : "Enable";
}

export function pluginCardSourceLabel(source: PluginCardSource): string {
  switch (source.kind) {
    case "bundled":
      return "Official";
    case "community":
      return "BB Community";
    case "third-party":
      return `${source.marketplace} · Not reviewed by BB`;
    case "local":
      return source.label;
  }
}

function CardFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        "relative my-2 flex max-w-md items-center gap-3 p-3",
        CONTEXT_CARD_CLASS,
      )}
    >
      {children}
    </div>
  );
}

function CardNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="my-2 max-w-md rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function ReadyCard({ card, onOpen }: { card: PluginCard; onOpen: () => void }) {
  const status = pluginCardStatus(card);
  const details = [card.category, pluginCardSourceLabel(card.source)].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  return (
    <CardFrame>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground">
        <PluginBrandIcon
          icon={card.icon}
          iconUrl={card.iconUrl}
          iconTinted={card.iconTinted}
          className="size-5"
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {card.displayName}
          </span>
          <span
            className={cn(
              "shrink-0 text-xs",
              card.installed && card.enabled
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
            {status}
          </span>
        </div>
        {card.description.length > 0 ? (
          <p
            className="truncate text-xs text-muted-foreground"
            title={card.description}
          >
            {card.description}
          </p>
        ) : null}
        <p
          className="truncate text-xs text-subtle-foreground"
          title={card.incompatibleReason ?? undefined}
        >
          {details.join(" · ")}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`${pluginCardActionLabel(card)} ${card.displayName}`}
        className="shrink-0 after:absolute after:inset-0 after:rounded-lg"
        onClick={onOpen}
      >
        {pluginCardActionLabel(card)}
      </Button>
    </CardFrame>
  );
}

function PluginCardDirective({ attributes }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof pluginCardsRpcContract>();
  const navigate = useBbNavigate();
  const pluginId = attributes.id?.trim() ?? "";
  const validId = PLUGIN_ID_PATTERN.test(pluginId);
  const [state, setState] = useState<CardState>({ status: "loading" });

  useEffect(() => {
    if (!validId) return;
    let cancelled = false;
    rpc.call("getPluginCard", { pluginId }).then(
      (result) => {
        if (cancelled) return;
        setState(
          result.kind === "found"
            ? { status: "ready", card: result.card }
            : { status: "not-found" },
        );
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pluginId, rpc, validId]);

  if (!validId) {
    return (
      <CardNotice>
        A plugin card needs a plugin id, e.g.{" "}
        <code>{`::${DIRECTIVE_ID}{id="browser-automation"}`}</code>
      </CardNotice>
    );
  }
  if (state.status === "loading") {
    return (
      <CardFrame>
        <div
          role="status"
          aria-busy="true"
          aria-label={`Loading plugin ${pluginId}`}
          className="flex flex-1 items-center gap-3"
        >
          <Skeleton className="size-9 shrink-0 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      </CardFrame>
    );
  }
  if (state.status === "not-found") {
    return (
      <CardNotice>
        No installed or store-listed plugin has the id <code>{pluginId}</code>.
      </CardNotice>
    );
  }
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="my-2 max-w-md rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        Couldn't load plugin {pluginId}: {state.message}
      </div>
    );
  }
  return (
    <ReadyCard
      card={state.card}
      onOpen={() => navigate.experimental_openPluginDetail(state.card.pluginId)}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({
    id: DIRECTIVE_ID,
    component: (props) => (
      <PluginCardDirective key={props.attributes.id?.trim() ?? ""} {...props} />
    ),
  });
});
