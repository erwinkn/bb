/// <reference types="node" />
import { threadCpuUsage } from "node:process";
import { expect, it } from "vitest";
import {
  clearParsedShellCommandIntentsCache,
  PARSED_INTENTS_CACHE_MAX_CHARS,
  PARSED_INTENTS_CACHE_MAX_COMMAND_CHARS,
  parseSentThreadMessage,
  parseShellCommandIntents,
} from "../src/tool-call-parsing.js";

it("bounds intent parsing work after a script's disqualifying write", () => {
  const payload = "synthetic payload words\n".repeat(20_000);
  const writeFirst = `cat > output.txt <<'EOF'\n${payload}EOF`;
  const readOnly = `cat '${payload}'`;
  expect(parseShellCommandIntents(writeFirst)).toEqual([]);
  expect(parseShellCommandIntents(readOnly)).toEqual([
    { type: "read", cmd: readOnly, name: "cat", path: payload },
  ]);

  const minimumCpu = (command: string): number => {
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const started = threadCpuUsage();
      for (let repeat = 0; repeat < 32; repeat += 1) {
        clearParsedShellCommandIntentsCache();
        parseShellCommandIntents(command);
      }
      const cpu = threadCpuUsage(started);
      samples.push(cpu.user + cpu.system);
    }
    return Math.min(...samples);
  };

  expect(minimumCpu(writeFirst)).toBeLessThan(minimumCpu(readOnly) / 8);
});

it("parses each distinct command once and returns the same intents on repeat", () => {
  const command = `cat '${"repeated words ".repeat(4_000)}'`;
  clearParsedShellCommandIntentsCache();
  const first = parseShellCommandIntents(command);
  const started = threadCpuUsage();
  for (let repeat = 0; repeat < 256; repeat += 1) {
    expect(parseShellCommandIntents(command)).toBe(first);
  }
  const cpu = threadCpuUsage(started);
  expect(cpu.user + cpu.system).toBeLessThan(100_000);
  clearParsedShellCommandIntentsCache();
  expect(parseShellCommandIntents(command)).not.toBe(first);
  expect(parseShellCommandIntents(command)).toEqual(first);
});

it("keeps oversized commands out of the intent cache", () => {
  const command = `cat '${"x".repeat(PARSED_INTENTS_CACHE_MAX_COMMAND_CHARS)}'`;
  clearParsedShellCommandIntentsCache();
  const first = parseShellCommandIntents(command);
  expect(parseShellCommandIntents(command)).not.toBe(first);
  expect(parseShellCommandIntents(command)).toEqual(first);
});

it("evicts the oldest commands once the cached text exceeds its budget", () => {
  clearParsedShellCommandIntentsCache();
  const commandChars = PARSED_INTENTS_CACHE_MAX_COMMAND_CHARS - 16;
  const command = (index: number) =>
    `cat '${String(index).padStart(8, "0")}${"y".repeat(commandChars - 16)}'`;
  const fitting = Math.floor(PARSED_INTENTS_CACHE_MAX_CHARS / commandChars);
  const firstIntents = parseShellCommandIntents(command(0));
  const lastIntents = [];
  for (let index = 1; index <= fitting; index += 1) {
    lastIntents.push(parseShellCommandIntents(command(index)));
  }
  expect(parseShellCommandIntents(command(fitting))).toBe(lastIntents.at(-1));
  expect(parseShellCommandIntents(command(0))).not.toBe(firstIntents);
  clearParsedShellCommandIntentsCache();
});

it("keeps bb thread tell parsing linear on unterminated heredocs", () => {
  const command = `bb thread tell thr_wrkr234567 --message-file - <<'EOF'\n${"x <<a\n".repeat(16_000)}`;
  const call = { command, exitCode: 0, status: "completed" } as const;
  expect(parseSentThreadMessage(call)).toBeNull();

  const started = threadCpuUsage();
  for (let repeat = 0; repeat < 32; repeat += 1) {
    parseSentThreadMessage(call);
  }
  const cpu = threadCpuUsage(started);
  expect(cpu.user + cpu.system).toBeLessThan(500_000);
});
