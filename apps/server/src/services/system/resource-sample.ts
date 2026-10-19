import { performance } from "node:perf_hooks";
import { roundDurationMs } from "@bb/process-utils";

export interface ResourceSample {
  cpu: NodeJS.CpuUsage;
  startedAt: number;
  usage: NodeJS.ResourceUsage;
}

export interface ResourceUsageDelta {
  cpuDurationMs: number;
  durationMs: number;
  fsReadBytes: number;
  majorPageFaults: number;
}

const FS_READ_BLOCK_BYTES = 512;

export function startResourceSample(): ResourceSample {
  return {
    cpu: process.threadCpuUsage(),
    startedAt: performance.now(),
    usage: process.resourceUsage(),
  };
}

export function finishResourceSample(
  sample: ResourceSample,
): ResourceUsageDelta {
  const durationMs = performance.now() - sample.startedAt;
  const cpu = process.threadCpuUsage(sample.cpu);
  const usage = process.resourceUsage();
  return {
    cpuDurationMs: roundDurationMs((cpu.user + cpu.system) / 1_000),
    durationMs: roundDurationMs(durationMs),
    fsReadBytes: (usage.fsRead - sample.usage.fsRead) * FS_READ_BLOCK_BYTES,
    majorPageFaults: usage.majorPageFault - sample.usage.majorPageFault,
  };
}
