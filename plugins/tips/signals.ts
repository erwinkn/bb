import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AUTOMATIONS_PLUGIN_ID } from "./catalog.js";
import type { LiveSignals, TipsState } from "./engine.js";

const SIGNAL_TIMEOUT_MS = 5_000;
const WAITING_SCAN_LIMIT = 100;

export interface WaitingThreadRow {
  status: string;
  hasPendingInteraction: boolean;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

const RUNNING_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "starting",
  "active",
  "stopping",
]);

export function isWaitingOnUser(thread: WaitingThreadRow): boolean {
  if (thread.hasPendingInteraction) return true;
  if (RUNNING_STATUSES.has(thread.status)) return false;
  if (thread.status === "error") return true;
  return (thread.lastReadAt ?? 0) < thread.latestAttentionAt;
}

async function settle<T>(
  bb: BbPluginApi,
  label: string,
  read: (signal: AbortSignal) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read(AbortSignal.timeout(SIGNAL_TIMEOUT_MS));
  } catch (error) {
    bb.log.debug(
      `Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return fallback;
  }
}

export function createAppVersionReader(
  bb: BbPluginApi,
): () => Promise<string | null> {
  let cached: string | null = null;
  return async () => {
    if (cached !== null) return cached;
    const version = await settle(
      bb,
      "the app version",
      async (signal) =>
        (await bb.sdk.system.version({ signal })).currentVersion,
      null,
    );
    cached = version;
    return version;
  };
}

function hasThreads(
  bb: BbPluginApi,
  label: string,
  filter: { projectId?: string; hasParent?: boolean; originPluginId?: string },
): Promise<boolean> {
  return settle(
    bb,
    label,
    async (signal) =>
      (await bb.sdk.threads.list({ ...filter, limit: 1, signal })).length > 0,
    false,
  );
}

export async function collectLiveSignals(
  bb: BbPluginApi,
  state: TipsState,
  readAppVersion: () => Promise<string | null>,
  projectId: string | null,
): Promise<LiveSignals> {
  const [
    appVersion,
    threadCount,
    finishedThreadCount,
    providersUsed,
    availableProviderCount,
    installedPlugins,
    hasChildThread,
    hasAutomationThread,
    waitingThreadCount,
    projectHasChildThread,
    projectHasAutomationThread,
  ] = await Promise.all([
    readAppVersion(),
    settle(
      bb,
      "the thread count",
      async (signal) => (await bb.sdk.threads.count({ signal })).total,
      0,
    ),
    settle(
      bb,
      "the finished thread count",
      async (signal) =>
        (await bb.sdk.threads.count({ status: "idle", signal })).total,
      0,
    ),
    settle(
      bb,
      "providers in use",
      async (signal) =>
        (
          (await bb.sdk.threads.count({ groupBy: "provider", signal }))
            .groups ?? []
        )
          .filter((group) => group.key !== null && group.count > 0)
          .map((group) => group.key)
          .filter((key): key is string => key !== null),
      [],
    ),
    settle(
      bb,
      "available providers",
      async () =>
        (await bb.sdk.providers.catalog()).filter(
          (entry) => entry.pluginEnabled && entry.enabled && entry.available,
        ).length,
      0,
    ),
    settle(
      bb,
      "installed plugins",
      async (signal) =>
        Object.fromEntries(
          (await bb.sdk.plugins.list({ signal })).plugins.map((plugin) => [
            plugin.id,
            plugin.enabled,
          ]),
        ),
      {},
    ),
    state.observed.childThread
      ? Promise.resolve(true)
      : hasThreads(bb, "child threads", { hasParent: true }),
    state.observed.automationThread
      ? Promise.resolve(true)
      : hasThreads(bb, "automation threads", {
          originPluginId: AUTOMATIONS_PLUGIN_ID,
        }),
    settle(
      bb,
      "threads waiting on you",
      async (signal) =>
        (
          await bb.sdk.threads.list({ limit: WAITING_SCAN_LIMIT, signal })
        ).filter(isWaitingOnUser).length,
      0,
    ),
    projectId === null
      ? Promise.resolve(false)
      : hasThreads(bb, "this project's child threads", {
          projectId,
          hasParent: true,
        }),
    projectId === null
      ? Promise.resolve(false)
      : hasThreads(bb, "this project's automation threads", {
          projectId,
          originPluginId: AUTOMATIONS_PLUGIN_ID,
        }),
  ]);
  return {
    projectId,
    serverPlatform: process.platform,
    appVersion,
    threadCount,
    finishedThreadCount,
    hasChildThread,
    hasAutomationThread,
    projectHasChildThread,
    projectHasAutomationThread,
    waitingThreadCount,
    providersUsed,
    availableProviderCount,
    installedPlugins,
  };
}
