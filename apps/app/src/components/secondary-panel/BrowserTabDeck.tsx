import { useMemo } from "react";
import { COARSE_POINTER_TEXT_SM_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import type { BrowserFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { getDesktopBrowserApi } from "@/lib/bb-desktop";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import {
  BrowserTabContent,
  type BrowserAddressFocusRequest,
} from "./BrowserTabContent";
import { createBrowserViewVisibilityCoordinator } from "./browserViewVisibilityCoordinator";
import type { UpdateBrowserTabArgs } from "./useThreadFileTabs";

interface BrowserTabDeckProps {
  browserTabs: readonly BrowserFixedPanelTab[];
  activeBrowserTabId: string | null;
  addressFocusRequest?: BrowserAddressFocusRequest | null;
  onAddressFocusRequestConsumed?: (request: BrowserAddressFocusRequest) => void;
  environmentId: string | null;
  canShowNativeBrowserView: boolean;
  canHandleBrowserCommands?: boolean;
  onNativeFocus?: () => void;
  threadId: string;
  onUpdate: (args: UpdateBrowserTabArgs) => void;
}

export function selectActiveBrowserTab(
  browserTabs: readonly BrowserFixedPanelTab[],
  activeBrowserTabId: string | null,
): BrowserFixedPanelTab | null {
  if (activeBrowserTabId === null) {
    return null;
  }
  return browserTabs.find((tab) => tab.id === activeBrowserTabId) ?? null;
}

export function BrowserTabDeck({
  browserTabs,
  activeBrowserTabId,
  addressFocusRequest = null,
  onAddressFocusRequestConsumed,
  environmentId,
  canShowNativeBrowserView,
  canHandleBrowserCommands = canShowNativeBrowserView,
  onNativeFocus,
  threadId,
  onUpdate,
}: BrowserTabDeckProps) {
  const desktopBrowser = useMemo(() => getDesktopBrowserApi(), []);
  const visibilityCoordinator = useMemo(
    () =>
      desktopBrowser === null
        ? null
        : createBrowserViewVisibilityCoordinator(desktopBrowser),
    [desktopBrowser],
  );

  const activeBrowserTab = selectActiveBrowserTab(
    browserTabs,
    activeBrowserTabId,
  );
  if (activeBrowserTab === null) {
    return null;
  }
  if (desktopBrowser === null) {
    return <BrowserTabNeedsDesktop url={activeBrowserTab.url} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
      <BrowserTabContent
        key={activeBrowserTab.id}
        tabId={activeBrowserTab.id}
        initialUrl={activeBrowserTab.url}
        addressFocusRequest={
          addressFocusRequest?.tabId === activeBrowserTab.id
            ? addressFocusRequest
            : null
        }
        onAddressFocusRequestConsumed={onAddressFocusRequestConsumed}
        canShowNativeBrowserView={canShowNativeBrowserView}
        canHandleBrowserCommands={canHandleBrowserCommands}
        onNativeFocus={onNativeFocus}
        visibilityCoordinator={visibilityCoordinator}
        environmentId={environmentId}
        threadId={threadId}
        onUpdate={onUpdate}
      />
    </div>
  );
}

function BrowserTabNeedsDesktop({ url }: { url: string }) {
  const parsedUrl = URL.canParse(url) ? new URL(url) : null;
  const canOpenExternally =
    parsedUrl?.protocol === "https:" || parsedUrl?.protocol === "http:";
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-sidebar px-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
        <Icon name="Globe" className="size-6" aria-hidden />
      </span>
      <div className="text-sm font-medium text-foreground">
        Browser tabs need the desktop app
      </div>
      <p
        className={cn(
          "max-w-xs text-muted-foreground",
          COARSE_POINTER_TEXT_SM_CLASS,
        )}
      >
        This tab is open in the bb desktop app.
      </p>
      {url.length > 0 ? (
        <p
          className={cn(
            "max-w-full truncate font-mono text-muted-foreground select-text",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
          title={url}
        >
          {url}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {url.length > 0 ? (
          <>
            {canOpenExternally ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openUrlInExternalBrowser(url)}
              >
                <Icon name="ExternalLink" aria-hidden />
                Open in browser
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void copyToClipboardWithToast(url, {
                  successMessage: "Link copied",
                });
              }}
            >
              <Icon name="Copy" aria-hidden />
              Copy link
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
