import { threadCpuUsage } from "node:process";
import { expect, it } from "vitest";
import type {
  EventProjectionFileEditMessage,
  EventProjectionMessage,
} from "../src/event-projection-message.js";
import { replaceKnownFileEditMessages } from "../src/operation-projection.js";

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

let nextId = 0;

function fileEdit(callId: string): EventProjectionFileEditMessage {
  nextId += 1;
  return {
    callId,
    id: `file-edit-${nextId}`,
    kind: "file-edit",
  } as unknown as EventProjectionFileEditMessage;
}

function other(): EventProjectionMessage {
  nextId += 1;
  return {
    id: `other-${nextId}`,
    kind: "assistant",
  } as unknown as EventProjectionMessage;
}

function replaceByScan(
  messages: readonly EventProjectionMessage[],
  callId: string,
  nextRows: readonly EventProjectionFileEditMessage[],
): EventProjectionMessage[] {
  const insertionIndex = messages.findIndex(
    (message) => message.kind === "file-edit" && message.callId === callId,
  );
  const kept = messages.filter(
    (message) => message.kind !== "file-edit" || message.callId !== callId,
  );
  if (insertionIndex === -1) kept.push(...nextRows);
  else kept.splice(insertionIndex, 0, ...nextRows);
  return kept;
}

it("replaces a call's file edits exactly like a full scan of the messages", () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = createRandom(seed);
    const callIds = ["call-a", "call-b", "call-c"];
    const messages: EventProjectionMessage[] = [];
    const length = Math.floor(random() * 40);
    for (let index = 0; index < length; index += 1) {
      messages.push(
        random() < 0.5
          ? other()
          : fileEdit(callIds[Math.floor(random() * callIds.length)]!),
      );
    }
    const callId = callIds[Math.floor(random() * callIds.length)]!;
    const previousRows = messages
      .filter(
        (message): message is EventProjectionFileEditMessage =>
          message.kind === "file-edit" && message.callId === callId,
      )
      .sort(() => random() - 0.5);
    const reused = previousRows.filter(() => random() < 0.5);
    const nextRows = [
      ...reused,
      ...Array.from({ length: Math.floor(random() * 4) }, () =>
        fileEdit(callId),
      ),
    ].sort(() => random() - 0.5);

    const expected = replaceByScan(messages, callId, nextRows);
    const actual = [...messages];
    expect(replaceKnownFileEditMessages(actual, previousRows, nextRows)).toBe(
      true,
    );
    expect(
      actual.map((message) => message.id),
      `seed ${seed}`,
    ).toEqual(expected.map((message) => message.id));
  }
});

it("declines when a previous row is no longer among the messages", () => {
  const stale = fileEdit("call-a");
  const messages = [other(), fileEdit("call-a")];
  const before = [...messages];
  expect(replaceKnownFileEditMessages(messages, [stale], [])).toBe(false);
  expect(messages).toEqual(before);
});

it("replaces a large multi-file call in time linear in the messages after it", () => {
  const previousRows = Array.from({ length: 2_048 }, () =>
    fileEdit("call-big"),
  );
  const later = Array.from({ length: 10_000 }, () => other());
  const nextRows = previousRows.map(() => fileEdit("call-big"));
  const cpuSamples: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const messages: EventProjectionMessage[] = [];
    previousRows.forEach((row, index) => {
      messages.push(row);
      if (index % 2 === 0) messages.push(later[index]!);
    });
    messages.push(...later);
    const expected = replaceByScan(messages, "call-big", nextRows);
    const started = threadCpuUsage();
    expect(replaceKnownFileEditMessages(messages, previousRows, nextRows)).toBe(
      true,
    );
    const cpu = threadCpuUsage(started);
    cpuSamples.push(cpu.user + cpu.system);
    expect(messages).toEqual(expected);
  }
  expect(Math.min(...cpuSamples)).toBeLessThan(10_000);
});
