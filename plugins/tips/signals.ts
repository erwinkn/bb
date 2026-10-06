import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AUTOMATIONS_PLUGIN_ID } from "./catalog.js";
import type { LiveSignals, TipsState } from "./engine.js";

const SIGNAL_TIMEOUT_MS = 5_000;

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

export async function collectLiveSignals(
  bb: BbPluginApi,
  state: TipsState,
  readAppVersion: () => Promise<string | null>,
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
      : settle(
          bb,
          "child threads",
          async (signal) =>
            (await bb.sdk.threads.list({ hasParent: true, limit: 1, signal }))
              .length > 0,
          false,
        ),
    state.observed.automationThread
      ? Promise.resolve(true)
      : settle(
          bb,
          "automation threads",
          async (signal) =>
            (
              await bb.sdk.threads.list({
                originPluginId: AUTOMATIONS_PLUGIN_ID,
                limit: 1,
                signal,
              })
            ).length > 0,
          false,
        ),
  ]);
  return {
    serverPlatform: process.platform,
    appVersion,
    threadCount,
    finishedThreadCount,
    hasChildThread,
    hasAutomationThread,
    providersUsed,
    availableProviderCount,
    installedPlugins,
  };
}
