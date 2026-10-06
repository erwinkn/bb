import { Worker } from "node:worker_threads";
import type { ServerLogger } from "../../types.js";

const HEARTBEAT_INTERVAL_MS = 20;
const HEARTBEAT_MODULO = 1_000_000_000;

export interface EventLoopStallSample {
  durationMs: number;
  samples: number;
  topFunctions: string[];
  topStack: string | null;
}

export interface EventLoopStallSampler {
  stop: () => void;
}

const SAMPLER_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { Session } = require("node:inspector");
const { heartbeat, modulo, startLagMs, settledLagMs, maxProfileMs, cooldownMs, pollMs, samplingIntervalUs } = workerData;
const session = new Session();
session.connectToMainThread();
const post = (method, params) => new Promise((resolve, reject) =>
  session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result))));
const lag = () => {
  const delta = (Date.now() % modulo) - Atomics.load(heartbeat, 0);
  return delta < 0 ? delta + modulo : delta;
};
const IGNORED = new Set(["(idle)", "(program)", "(root)"]);
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
let peakLag = 0;
let lastSampleAt = 0;
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const current = lag();
    if (profilingSince === null) {
      if (current >= startLagMs && Date.now() - lastSampleAt >= cooldownMs) {
        profilingSince = Date.now() - current;
        peakLag = current;
        await post("Profiler.start");
      }
    } else {
      peakLag = Math.max(peakLag, current);
      if (current <= settledLagMs || Date.now() - profilingSince >= maxProfileMs) {
        const { profile } = await post("Profiler.stop");
        lastSampleAt = Date.now();
        parentPort.postMessage(summarize(profile, Date.now() - profilingSince));
        profilingSince = null;
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
    "topFunctions" in value
  );
}

export function startEventLoopStallSampler(options: {
  logger: Pick<ServerLogger, "info" | "warn">;
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
      samplingIntervalUs: 1_000,
      settledLagMs: 100,
      startLagMs: 250,
    },
  });
  worker.unref();
  worker.on("message", (message: unknown) => {
    if (isStallSample(message)) {
      options.logger.info(message, "Event loop stall sampled");
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
