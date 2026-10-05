import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";

const target = "packages/plugin-sdk/scripts/shared-declaration-emit.mjs";
const fixed = readFileSync(target, "utf8");
const baseline = execFileSync("git", ["show", `0fde1a8beef2544d19ca430352ed648b63e9d75d:${target}`], { encoding: "utf8" });
const results = [];
let expectedManifest;
try {
  for (const variant of ["baseline", "fixed", "fixed", "baseline"]) {
    writeFileSync(target, variant === "baseline" ? baseline : fixed);
    rmSync("packages/plugin-sdk/bundled-types", { recursive: true, force: true });
    console.log(`BENCHMARK START ${variant} round ${results.length + 1}`);
    const started = performance.now();
    execSync('pnpm exec turbo run build:types --filter=@get-bb/plugin-sdk --force --summarize --output-logs=full', { stdio: "inherit" });
    const elapsedMs = performance.now() - started;
    const summaries = readdirSync(".turbo/runs").filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(`.turbo/runs/${name}`, "utf8")));
    const task = summaries.flatMap(summary => summary.tasks).filter(task => task.taskId === "@get-bb/plugin-sdk#build:types").sort((a, b) => b.execution.startTime - a.execution.startTime)[0];
    const manifest = Object.fromEntries(readdirSync("packages/plugin-sdk/bundled-types").sort().map(name => [name, createHash("sha256").update(readFileSync(`packages/plugin-sdk/bundled-types/${name}`)).digest("hex")]));
    expectedManifest ??= manifest;
    const outputsMatch = JSON.stringify(manifest) === JSON.stringify(expectedManifest);
    const result = { variant, round: results.length + 1, elapsedMs, taskMs: task.execution.endTime - task.execution.startTime, cache: task.cache, outputsMatch, manifest };
    results.push(result);
    writeFileSync("ci-benchmark-results.json", JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
    console.log(`BENCHMARK RESULT ${JSON.stringify(result)}`);
    if (!outputsMatch) throw new Error("Declaration outputs changed between baseline and fix");
  }
} finally {
  writeFileSync(target, fixed);
}
