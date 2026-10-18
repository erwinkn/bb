import { startEventLoopDelaySampler } from "@bb/process-utils";
import type { ServerLogger } from "../../types.js";
import { takeEventLoopWorkWindowSnapshot } from "./event-loop-work.js";
import {
  startGcAttribution,
  startSpawnAttribution,
  takeEventLoopAttributionWindow,
} from "./event-loop-stall-attribution.js";
import type { SampledEventLoopStall } from "./event-loop-stall-sampler.js";

export interface EventLoopStallMonitorOptions {
  logger: Pick<ServerLogger, "info">;
  now?: () => number;
  thresholdMs?: number | (() => number);
}

export interface EventLoopStallMonitor {
  noteSampledStall: (sample: SampledEventLoopStall) => void;
  stop: () => void;
}

export function startEventLoopStallMonitor(
  options: EventLoopStallMonitorOptions,
): EventLoopStallMonitor {
  const stopGcAttribution = startGcAttribution();
  const stopSpawnAttribution = startSpawnAttribution();
  let sampledStalls: SampledEventLoopStall[] = [];
  let loggedStallLastWindow = false;
  const sampler = startEventLoopDelaySampler({
    now: options.now,
    thresholdMs: options.thresholdMs,
    onSample: ({ stall }) => {
      const work = takeEventLoopWorkWindowSnapshot();
      const attribution = takeEventLoopAttributionWindow();
      const sampled = sampledStalls;
      sampledStalls = [];
      const loggedStallPreviousWindow = loggedStallLastWindow;
      loggedStallLastWindow = stall !== null;
      if (stall === null) {
        const longest = sampled.reduce<SampledEventLoopStall | null>(
          (found, sample) =>
            found === null || sample.durationMs > found.durationMs
              ? sample
              : found,
          null,
        );
        if (longest === null || loggedStallPreviousWindow) return;
        options.logger.info(
          {
            detectedBy: "sampler",
            durationMs: longest.durationMs,
            mainThread: longest.mainThread,
            maxDelayMs: longest.peakLagMs,
            spawnCount: longest.spawnCount,
            spawnMs: longest.spawnMs,
            startedAt: longest.startedAt,
            topStack: longest.topStack,
            ...work,
            stallAttribution: "unattributed",
            stallCauseCandidate: null,
          },
          "Event loop stalled",
        );
        options.logger.info(
          { maxDelayMs: longest.peakLagMs, ...attribution },
          "Event loop stall attributed",
        );
        return;
      }
      const hasCandidate =
        work.longestSynchronousWorkWallMs !== null &&
        work.longestSynchronousWorkWallMs + stall.resolutionMs >=
          stall.maxDelayMs;
      options.logger.info(
        {
          ...stall,
          ...work,
          stallAttribution: hasCandidate ? "candidate" : "unattributed",
          stallCauseCandidate: hasCandidate
            ? work.longestSynchronousWork
            : null,
        },
        "Event loop stalled",
      );
      options.logger.info(
        { maxDelayMs: stall.maxDelayMs, ...attribution },
        "Event loop stall attributed",
      );
    },
  });
  return {
    noteSampledStall: (sample) => {
      sampledStalls.push(sample);
    },
    stop: () => {
      sampler.stop();
      stopGcAttribution();
      stopSpawnAttribution();
    },
  };
}
