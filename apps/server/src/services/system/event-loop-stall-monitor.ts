import { startEventLoopDelaySampler } from "@bb/process-utils";
import type { ServerLogger } from "../../types.js";
import { takeEventLoopWorkWindowSnapshot } from "./event-loop-work.js";
import {
  startGcAttribution,
  takeEventLoopAttributionWindow,
} from "./event-loop-stall-attribution.js";

export interface EventLoopStallMonitorOptions {
  logger: Pick<ServerLogger, "info">;
  now?: () => number;
  thresholdMs?: number | (() => number);
}

export interface EventLoopStallMonitor {
  stop: () => void;
}

export function startEventLoopStallMonitor(
  options: EventLoopStallMonitorOptions,
): EventLoopStallMonitor {
  const stopGcAttribution = startGcAttribution();
  const sampler = startEventLoopDelaySampler({
    now: options.now,
    thresholdMs: options.thresholdMs,
    onSample: ({ stall }) => {
      const work = takeEventLoopWorkWindowSnapshot();
      const attribution = takeEventLoopAttributionWindow();
      if (stall === null) return;
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
    stop: () => {
      sampler.stop();
      stopGcAttribution();
    },
  };
}
