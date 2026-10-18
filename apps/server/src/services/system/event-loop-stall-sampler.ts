import { Worker } from "node:worker_threads";
import type { ServerLogger } from "../../types.js";
import { summarizeSpawnsBetween } from "./event-loop-stall-attribution.js";

const HEARTBEAT_INTERVAL_MS = 20;
const HEARTBEAT_MODULO = 1_000_000_000;

export interface EventLoopStallMainThread {
  cpuMs: number;
  majorFaults: number;
  offCpuMs: number;
  runQueueMs: number;
  wallMs: number;
}

export interface EventLoopStallSample {
  durationMs: number;
  mainThread: EventLoopStallMainThread | null;
  peakLagMs: number;
  samples: number;
  startedAt: number;
  topFunctions: string[];
  topStack: string | null;
}

export interface SampledEventLoopStall extends EventLoopStallSample {
  spawnCount: number;
  spawnMs: number;
}

export interface EventLoopStallSampler {
  stop: () => void;
}

const SAMPLER_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const { Session } = require("node:inspector");
const { heartbeat, modulo, startLagMs, settledLagMs, maxProfileMs, cooldownMs, pollMs, samplingIntervalUs, readingLimit } = workerData;
const session = new Session();
session.connectToMainThread();
const post = (method, params) => new Promise((resolve, reject) =>
  session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result))));
const lag = () => {
  const delta = (Date.now() % modulo) - Atomics.load(heartbeat, 0);
  return delta < 0 ? delta + modulo : delta;
};
const IGNORED = new Set(["(idle)", "(program)", "(root)"]);
const mainTask = "/proc/self/task/" + process.pid;
const readings = [];
function readMainThread() {
  try {
    const schedstat = readFileSync(mainTask + "/schedstat", "utf8").trim().split(/\\s+/);
    const stat = readFileSync(mainTask + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { at: Date.now(), runNs: Number(schedstat[0]), waitNs: Number(schedstat[1]), majorFaults: Number(fields[9]) };
  } catch {
    return null;
  }
}
function remember(reading) {
  if (reading === null) return;
  readings.push(reading);
  if (readings.length > readingLimit) readings.shift();
}
function readingAtOrBefore(at) {
  let found = readings[0] ?? null;
  for (const reading of readings) if (reading.at <= at) found = reading;
  return found;
}
function mainThreadBetween(start, end) {
  if (start === null || end === null) return null;
  const round = (value) => Math.round(value * 10) / 10;
  const wallMs = end.at - start.at;
  const cpuMs = (end.runNs - start.runNs) / 1e6;
  const runQueueMs = (end.waitNs - start.waitNs) / 1e6;
  return {
    cpuMs: round(cpuMs),
    majorFaults: end.majorFaults - start.majorFaults,
    offCpuMs: round(Math.max(0, wallMs - cpuMs - runQueueMs)),
    runQueueMs: round(runQueueMs),
    wallMs,
  };
}
function frameName(frame) {
  const file = frame.url ? frame.url.split("/").pop() : "";
  const name = frame.functionName || "(anonymous)";
  return file ? name + " " + file + ":" + (frame.lineNumber + 1) : name;
}
function summarize(profile, durationMs) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const deltas = profile.timeDeltas ?? [];
  const self = new Map();
  const stacks = new Map();
  profile.samples.forEach((id, index) => {
    const node = nodes.get(id);
    if (!node || IGNORED.has(node.callFrame.functionName)) return;
    const weight = (deltas[index + 1] ?? deltas[index] ?? 0) / 1000;
    const name = frameName(node.callFrame);
    self.set(name, (self.get(name) ?? 0) + weight);
    const frames = [];
    for (let cursor = id; cursor !== undefined && frames.length < 12; cursor = parents.get(cursor)) {
      const frame = nodes.get(cursor).callFrame;
      if (frame.functionName === "(root)") break;
      frames.push(frameName(frame));
    }
    const key = frames.join(" < ");
    stacks.set(key, (stacks.get(key) ?? 0) + weight);
  });
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const stack = [...stacks].sort((a, b) => b[1] - a[1])[0];
  return {
    durationMs: Math.round(durationMs),
    samples: profile.samples.length,
    topFunctions: top.map(([name, ms]) => name + " " + Math.round(ms) + "ms"),
    topStack: stack ? stack[0] : null,
  };
}
let profilingSince = null;
let profilingBaseline = null;
let peakLag = 0;
let lastSampleAt = 0;
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const current = lag();
    if (profilingSince === null) {
      remember(readMainThread());
      if (current >= startLagMs && Date.now() - lastSampleAt >= cooldownMs) {
        profilingSince = Date.now() - current;
        profilingBaseline = readingAtOrBefore(profilingSince);
        peakLag = current;
        await post("Profiler.start");
      }
    } else {
      peakLag = Math.max(peakLag, current);
      if (current <= settledLagMs || Date.now() - profilingSince >= maxProfileMs) {
        const { profile } = await post("Profiler.stop");
        const settled = readMainThread();
        lastSampleAt = Date.now();
        parentPort.postMessage({
          ...summarize(profile, Date.now() - profilingSince),
          mainThread: mainThreadBetween(profilingBaseline, settled),
          peakLagMs: peakLag,
          startedAt: profilingSince,
        });
        profilingSince = null;
        profilingBaseline = null;
        readings.length = 0;
        remember(settled);
      }
    }
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
    profilingSince = null;
  } finally {
    busy = false;
  }
}, pollMs);
post("Profiler.enable").then(() => post("Profiler.setSamplingInterval", { interval: samplingIntervalUs }));
`;

function isStallSample(value: unknown): value is EventLoopStallSample {
  return (
    typeof value === "object" &&
    value !== null &&
    "samples" in value &&
    "topFunctions" in value &&
    "startedAt" in value
  );
}

export function startEventLoopStallSampler(options: {
  logger: Pick<ServerLogger, "info" | "warn">;
  onSample?: (sample: SampledEventLoopStall) => void;
}): EventLoopStallSampler {
  const heartbeat = new Int32Array(new SharedArrayBuffer(4));
  const beat = () => Atomics.store(heartbeat, 0, Date.now() % HEARTBEAT_MODULO);
  beat();
  const interval = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  interval.unref();
  const worker = new Worker(SAMPLER_WORKER_SOURCE, {
    eval: true,
    workerData: {
      cooldownMs: 10_000,
      heartbeat,
      maxProfileMs: 10_000,
      modulo: HEARTBEAT_MODULO,
      pollMs: 50,
      readingLimit: 40,
      samplingIntervalUs: 1_000,
      settledLagMs: 100,
      startLagMs: 250,
    },
  });
  worker.unref();
  worker.on("message", (message: unknown) => {
    if (isStallSample(message)) {
      const sample: SampledEventLoopStall = {
        ...message,
        ...summarizeSpawnsBetween(
          message.startedAt,
          message.startedAt + message.durationMs,
        ),
      };
      options.logger.info(sample, "Event loop stall sampled");
      options.onSample?.(sample);
    } else {
      options.logger.warn({ message }, "Event loop stall sampler failed");
    }
  });
  worker.on("error", (error) => {
    options.logger.warn({ err: error }, "Event loop stall sampler stopped");
  });
  return {
    stop: () => {
      clearInterval(interval);
      void worker.terminate();
    },
  };
}
