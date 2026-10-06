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
    onSample: ({ stall }) => {
      const work = takeEventLoopWorkWindowSnapshot();
      const attribution = takeEventLoopAttributionWindow();
      if (stall === null) return;
      options.logger.info({ ...stall, ...work }, "Event loop stalled");
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
