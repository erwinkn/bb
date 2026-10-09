import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const { queryMock, seedQueryMock, sdk, trackers } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  seedQueryMock: vi.fn(),
  sdk: { query: null as unknown as (args: unknown) => unknown },
  trackers: [] as Array<{ handleToolCallResponse: (r: never) => boolean }>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  sdk.query = (await importOriginal<{ query: typeof sdk.query }>()).query;
  return {
    query: (args: { options?: { title?: string } }) =>
      args.options?.title === "BB OptChat seed"
        ? seedQueryMock(args)
        : queryMock(args),
    forkSession: vi.fn(),
    createSdkMcpServer: vi.fn(() => ({})),
    tool: vi.fn((_name, _desc, _schema, handler) => handler),
  };
});

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...actual,
    createPendingToolCallTracker: (
      options: Parameters<typeof actual.createPendingToolCallTracker>[0],
    ) => {
      const tracker = actual.createPendingToolCallTracker(options);
      trackers.push(tracker as never);
      return tracker;
    },
  };
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleLine } from "../bridge.js";
import {
  TURN_CONTEXT_TIMEOUT_MS,
  extendSystemPrompt,
  parseTurnContext,
} from "../turn-context.js";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcOutputMessage } from "@get-bb/plugin-sdk/provider-bridge/testing";

interface QueryCall {
  prompt: AsyncIterable<SDKUserMessage>;
  options: {
    allowDangerouslySkipPermissions?: boolean;
    allowedTools?: string[];
    forkSession?: boolean;
    mcpServers?: Record<string, { instance: McpServer }>;
    permissionMode?: string;
    resume?: string;
    sessionId?: string;
    systemPrompt?: unknown;
    title?: string;
  };
}

const THREAD_ID = "thr_turn_context";
const FRESH_SESSION_ID = "6f1c2a4e-8b3d-4c5f-9a7e-0d1b2c3e4f5a";
const HANDOVER_SESSION_ID = "0b6f1d2e-3c4a-4b5d-8e6f-7a8b9c0d1e2f";
const SECOND_REQUEST = "creq_bcdefghjkm";
const TURN_CONTEXT_TOOL = "claude_code_turn_context";

function controlledQuery() {
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(() => finish?.()),
    getContextUsage: vi.fn().mockResolvedValue(null),
    initializationResult: vi
      .fn()
      .mockResolvedValue({ account: {}, models: [] }),
    interrupt: vi.fn(async () => finish?.()),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await done;
          return { value: undefined, done: true as const };
        },
        return: async () => ({ value: undefined, done: true as const }),
      };
    },
  };
}

function failedInitQuery(message: string) {
  const query = controlledQuery();
  query.initializationResult = vi.fn().mockRejectedValue(new Error(message));
  return query;
}

function seededQuery(call: QueryCall, subtype = "success") {
  const query = controlledQuery();
  const prompts = call.prompt[Symbol.asyncIterator]();
  let replied = false;
  return {
    ...query,
    [Symbol.asyncIterator]() {
      const rest = query[Symbol.asyncIterator]();
      return {
        next: async () => {
          if (replied) return rest.next();
          replied = true;
          await prompts.next();
          return {
            value: { type: "result", subtype, is_error: subtype !== "success" },
            done: false as const,
          };
        },
        return: rest.return,
      };
    },
  };
}

function queryCalls(): QueryCall[] {
  return queryMock.mock.calls.map((call) => call[0] as QueryCall);
}

function seedCalls(): QueryCall[] {
  return seedQueryMock.mock.calls.map((call) => call[0] as QueryCall);
}

async function nextPromptText(call: QueryCall): Promise<string> {
  const result = await call.prompt[Symbol.asyncIterator]().next();
  if (result.done) throw new Error("Expected a prompt");
  const content = result.value.message.content;
  if (typeof content !== "string") throw new Error("Expected text");
  return content;
}

const dynamicTools = [
  {
    name: TURN_CONTEXT_TOOL,
    description: "hidden",
    inputSchema: { type: "object" },
  },
  {
    name: "initiative_read",
    description: "read",
    inputSchema: { type: "object" },
  },
];

function options() {
  return {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
    instructions: "BB instructions",
    providerOptions: { workflowsEnabled: false },
  };
}

type Harness = ReturnType<typeof createBridgeJsonRpcTestHarness>;

async function startThread(
  bridge: Harness,
  tools = dynamicTools,
): Promise<string> {
  bridge.sendRequest("start", "thread/start", {
    cwd: "/tmp/worktree",
    instructionMode: "append",
    options: options(),
    threadId: THREAD_ID,
    dynamicTools: tools,
  });
  const response = await bridge.waitForResponse("start");
  return (response.result as { providerThreadId: string }).providerThreadId;
}

function sendTurn(
  bridge: Harness,
  id: string,
  text: string,
  method = "turn/start",
  clientRequestId = "creq_abcdefghjk",
  turnTools?: typeof dynamicTools,
): void {
  bridge.sendRequest(id, method, {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    clientRequestId,
    ...(method === "turn/steer" ? { expectedTurnId: "turn-test" } : {}),
    input: [{ type: "text", text, mentions: [] }],
    options: options(),
    ...(turnTools ? { dynamicTools: turnTools } : {}),
  });
}

async function waitForToolCall(
  bridge: Harness,
): Promise<BridgeJsonRpcOutputMessage> {
  for (let tick = 0; tick < 200; tick++) {
    const call = bridge.messages.find(
      (message) =>
        message.method === "item/tool/call" && !answered.has(message.id!),
    );
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Expected a turn context tool call");
}

const answered = new Set<string | number>();

function answerToolCall(
  call: BridgeJsonRpcOutputMessage,
  text: string,
  success = true,
): void {
  answered.add(call.id!);
  handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: call.id,
      result: { success, contentItems: [{ type: "inputText", text }] },
    }),
  );
}

let bridge: Harness;

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockImplementation(() => controlledQuery());
  seedQueryMock.mockImplementation((call: QueryCall) => seededQuery(call));
  bridge = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  bridge.sendRequest("stop", "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    intent: "interrupt",
    activeTurnId: null,
  });
  await bridge.waitForResponse("stop");
  bridge.restore();
});

it("hides the turn context tool from the model", async () => {
  await startThread(bridge);
  expect(queryCalls()[0]!.options.allowedTools).toEqual([
    "mcp__bb-bridge__initiative_read",
  ]);
});

it("runs a turn in a fresh session with the turn context's system prompt and first message", async () => {
  const first = await startThread(bridge);
  sendTurn(bridge, "turn-1", "What did I ask first?");
  const call = await waitForToolCall(bridge);
  expect(call.params).toMatchObject({
    threadId: THREAD_ID,
    tool: TURN_CONTEXT_TOOL,
    arguments: { input: "What did I ask first?" },
  });
  const accepted = bridge.messages.findIndex((message) =>
    JSON.stringify(message.params ?? null).includes('"input.accepted"'),
  );
  expect(accepted).toBeGreaterThanOrEqual(0);
  expect(accepted).toBeLessThan(bridge.messages.indexOf(call));
  answerToolCall(
    call,
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "# Memory\n<chat>\n0+1|user: hi\n</chat>",
      input:
        "Now: 2026-10-08 09:22 UTC.\n\nNew message:\nWhat did I ask first?",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(2));
  const [resident, fresh] = queryCalls();
  const prompt = nextPromptText(fresh!);
  await bridge.waitForResponse("turn-1");
  expect(resident!.options.sessionId).toBe(first);
  expect(fresh!.options).toMatchObject({
    resume: seedCalls()[0]!.options.sessionId,
    forkSession: true,
    sessionId: FRESH_SESSION_ID,
    title: "BB OptChat turn",
  });
  expect(fresh!.options.systemPrompt).toEqual({
    type: "preset",
    preset: "claude_code",
    append: "BB instructions\n\n# Memory\n<chat>\n0+1|user: hi\n</chat>",
  });
  expect(await prompt).toBe(
    "Now: 2026-10-08 09:22 UTC.\n\nNew message:\nWhat did I ask first?",
  );
  const identities = bridge.messages.filter(
    (message) => message.method === "thread/identity",
  );
  expect(identities.at(-1)!.params).toMatchObject({
    threadId: THREAD_ID,
    providerThreadId: fresh!.options.sessionId,
  });

  sendTurn(bridge, "turn-2", "And then?");
  const second = await waitForToolCall(bridge);
  expect(second.params).toMatchObject({
    providerThreadId: fresh!.options.sessionId,
  });
  answerToolCall(
    second,
    JSON.stringify({
      session: "fresh",
      sessionId: HANDOVER_SESSION_ID,
      systemPrompt: "",
      input: "handover",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(3));
  const handover = queryCalls()[2]!;
  const handoverPrompt = nextPromptText(handover);
  await bridge.waitForResponse("turn-2");
  expect(queryMock.mock.results[1]!.value.close).toHaveBeenCalled();
  expect(handover.options.systemPrompt).toEqual({
    type: "preset",
    preset: "claude_code",
    append: "BB instructions",
  });
  expect(await handoverPrompt).toBe("handover");
});

it("lets the session go on when the turn context answers {}", async () => {
  await startThread(bridge);
  const resident = queryCalls()[0]!;
  sendTurn(bridge, "turn-1", "Hello");
  answerToolCall(await waitForToolCall(bridge), "{}");
  expect(await nextPromptText(resident)).toBe("Hello");
  expect((await bridge.waitForResponse("turn-1")).error).toBeUndefined();

  sendTurn(bridge, "turn-2", "Again", "turn/start", SECOND_REQUEST);
  answerToolCall(await waitForToolCall(bridge), "{}");
  expect(await nextPromptText(resident)).toBe("Again");
  expect((await bridge.waitForResponse("turn-2")).error).toBeUndefined();
  expect(queryCalls()).toHaveLength(1);
});

it.each([
  ["the plugin fails", "memory plugin unavailable", false],
  ["the answer is not JSON", "not json", true],
  [
    "a fresh answer is malformed",
    JSON.stringify({ session: "fresh", sessionId: FRESH_SESSION_ID }),
    true,
  ],
  ["the answer is something else", JSON.stringify({ input: "x" }), true],
  [
    "the answer is a protocol 3 acknowledgement",
    JSON.stringify({ ack: "creq_abcdefghjk" }),
    true,
  ],
])(
  "fails the turn, its held steer and never runs them in the resident when %s",
  async (_case, text, success) => {
    const first = await startThread(bridge);
    const resident = queryCalls()[0]!;
    sendTurn(bridge, "turn-1", "Hello");
    const call = await waitForToolCall(bridge);
    sendTurn(bridge, "steer-1", "Correction", "turn/steer");
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    answerToolCall(call, text, success);
    expect((await bridge.waitForResponse("turn-1")).error?.message).toContain(
      "Claude Code could not get the turn's memory context",
    );
    expect((await bridge.waitForResponse("steer-1")).error).toBeDefined();
    expect(
      bridge.messages.some(
        (message) =>
          message.method === "error" &&
          JSON.stringify(message.params).includes("memory context"),
      ),
    ).toBe(true);

    sendTurn(bridge, "turn-2", "Again", "turn/start", SECOND_REQUEST);
    const second = await waitForToolCall(bridge);
    expect(second.params).toMatchObject({
      arguments: { sessionId: first },
    });
    answerToolCall(second, "{}");
    expect(await nextPromptText(resident)).toBe("Again");
    await bridge.waitForResponse("turn-2");
    expect(queryCalls()).toHaveLength(1);
    expect(seedCalls()).toHaveLength(0);
  },
);

it.each([
  ["queued behind the turn before its context was asked for", false],
  ["arriving after the turn failed", true],
])(
  "fails a steer %s with the turn's memory context error, and never runs it in the resident",
  async (_case, late) => {
    await startThread(bridge);
    const resident = queryCalls()[0]!;
    sendTurn(bridge, "turn-1", "Hello");
    if (!late) sendTurn(bridge, "steer-1", "Correction", "turn/steer");
    answerToolCall(
      await waitForToolCall(bridge),
      "memory plugin unavailable",
      false,
    );
    const failed = await bridge.waitForResponse("turn-1");
    if (late) sendTurn(bridge, "steer-1", "Correction", "turn/steer");
    expect((await bridge.waitForResponse("steer-1")).error).toEqual(
      failed.error,
    );

    sendTurn(bridge, "turn-2", "Again", "turn/start", SECOND_REQUEST);
    answerToolCall(await waitForToolCall(bridge), "{}");
    expect(await nextPromptText(resident)).toBe("Again");
    expect((await bridge.waitForResponse("turn-2")).error).toBeUndefined();
  },
);

it("sends a steer that arrives after its turn finished back to BB as stale, so it starts a new turn with its own context", async () => {
  queryMock.mockImplementationOnce((call: QueryCall) => seededQuery(call));
  await startThread(bridge);
  const resident = queryCalls()[0]!;
  sendTurn(bridge, "turn-1", "Hello");
  answerToolCall(await waitForToolCall(bridge), "{}");
  expect((await bridge.waitForResponse("turn-1")).error).toBeUndefined();
  await vi.waitFor(() =>
    expect(
      bridge.messages.some((message) =>
        JSON.stringify(message.params ?? null).includes('"turn.boundary"'),
      ),
    ).toBe(true),
  );

  sendTurn(bridge, "steer-1", "Late correction", "turn/steer");
  expect((await bridge.waitForResponse("steer-1")).error).toMatchObject({
    code: -32001,
    data: { recovery: { kind: "staleTurn", retryable: false } },
  });
  sendTurn(bridge, "turn-2", "Again", "turn/start", SECOND_REQUEST);
  answerToolCall(await waitForToolCall(bridge), "{}");
  expect(await nextPromptText(resident)).toBe("Again");
});

it("never asks for steered input or threads without the tool", async () => {
  await startThread(bridge, dynamicTools.slice(1));
  sendTurn(bridge, "turn-1", "Hello");
  expect(await nextPromptText(queryCalls()[0]!)).toBe("Hello");
  await bridge.waitForResponse("turn-1");
  expect(
    bridge.messages.some((message) => message.method === "item/tool/call"),
  ).toBe(false);
});

it("appends to every system prompt shape and parses a fresh session answer", () => {
  const fresh = {
    session: "fresh",
    sessionId: FRESH_SESSION_ID,
    systemPrompt: "",
    input: "x",
  };
  const resident = { ok: true, context: null };
  const failed = { ok: false, error: expect.any(String) };
  expect(
    extendSystemPrompt({ type: "preset", preset: "claude_code" }, "view"),
  ).toEqual({ type: "preset", preset: "claude_code", append: "view" });
  expect(extendSystemPrompt("base", "view")).toBe("base\n\nview");
  expect(extendSystemPrompt("base", "")).toBe("base");
  expect(parseTurnContext({ content: "{}" })).toEqual(resident);
  expect(parseTurnContext({ content: JSON.stringify(fresh) })).toEqual({
    ok: true,
    context: fresh,
  });
  expect(
    parseTurnContext({ content: JSON.stringify(fresh), isError: true }),
  ).toEqual({ ok: false, error: JSON.stringify(fresh) });
  for (const content of [
    "not json",
    "null",
    "[]",
    '"resident"',
    JSON.stringify({ ack: "creq_a" }),
    JSON.stringify({ ...fresh, ack: "creq_a" }),
    JSON.stringify({ ack: "creq_a", sessionId: FRESH_SESSION_ID }),
    JSON.stringify({ ...fresh, session: "resident" }),
    JSON.stringify({ ...fresh, sessionId: undefined }),
    JSON.stringify({ ...fresh, sessionId: "../not-a-session" }),
    JSON.stringify({ ...fresh, input: "" }),
  ]) {
    expect(parseTurnContext({ content })).toEqual(failed);
  }
});

it("asks with the turn's text, request and session, and runs a fresh session under the id the answer names", async () => {
  const first = await startThread(bridge);
  sendTurn(bridge, "turn-1", "Hello");
  const call = await waitForToolCall(bridge);
  expect((call.params as { arguments: unknown }).arguments).toEqual({
    protocol: 4,
    input: "Hello",
    requestId: "creq_abcdefghjk",
    sessionId: first,
  });
  answerToolCall(
    call,
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "memory",
      input: "Framed",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(2));
  const fresh = queryCalls()[1]!;
  expect(fresh.options.sessionId).toBe(FRESH_SESSION_ID);
  const prompts = fresh.prompt[Symbol.asyncIterator]();
  await prompts.next();
  await bridge.waitForResponse("turn-1");
  expect(
    bridge.messages
      .filter((message) => message.method === "thread/identity")
      .at(-1)!.params,
  ).toMatchObject({ providerThreadId: FRESH_SESSION_ID });

  sendTurn(bridge, "turn-2", "Again", "turn/start", SECOND_REQUEST);
  const second = await waitForToolCall(bridge);
  expect((second.params as { arguments: unknown }).arguments).toEqual({
    protocol: 4,
    input: "Again",
    requestId: SECOND_REQUEST,
    sessionId: FRESH_SESSION_ID,
  });
  answerToolCall(second, "{}");
  await prompts.next();
  await bridge.waitForResponse("turn-2");
  expect(queryCalls()).toHaveLength(2);
});

it("fails the turn, and keeps the resident without its input, when the fresh session fails to start forked and unforked", async () => {
  const first = await startThread(bridge);
  const resident = queryCalls()[0]!;
  queryMock
    .mockImplementationOnce(() => failedInitQuery("No conversation found"))
    .mockImplementationOnce(() => {
      throw new Error("spawn claude ENOENT");
    });
  sendTurn(bridge, "turn-1", "Hello");
  answerToolCall(
    await waitForToolCall(bridge),
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "memory",
      input: "Framed",
    }),
  );
  expect((await bridge.waitForResponse("turn-1")).error?.message).toContain(
    "could not start the turn's fresh session: spawn claude ENOENT",
  );
  expect(seedCalls()).toHaveLength(1);
  expect(queryCalls()).toHaveLength(3);
  expect(queryCalls()[1]!.options).toMatchObject({ forkSession: true });
  expect(queryCalls()[2]!.options.forkSession).toBeUndefined();
  expect(queryMock.mock.results[0]!.value.close).not.toHaveBeenCalled();

  sendTurn(bridge, "turn-2", "Again", "turn/start", SECOND_REQUEST);
  const second = await waitForToolCall(bridge);
  expect(second.params).toMatchObject({
    arguments: { sessionId: first },
  });
  answerToolCall(second, "{}");
  expect(await nextPromptText(resident)).toBe("Again");
  await bridge.waitForResponse("turn-2");
});

it("holds a steer sent while the context is fetched, then delivers it after the turn's input to the fresh session", async () => {
  await startThread(bridge);
  sendTurn(bridge, "turn-1", "Original request");
  const call = await waitForToolCall(bridge);
  sendTurn(bridge, "steer-1", "Urgent correction", "turn/steer");
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  answerToolCall(
    call,
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "memory",
      input: "Framed original request",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(2));
  const fresh = queryCalls()[1]!.prompt[Symbol.asyncIterator]();
  const text = async () => {
    const next = await fresh.next();
    return (next.value as SDKUserMessage).message.content;
  };
  expect(await text()).toBe("Framed original request");
  expect(await text()).toBe("Urgent correction");
  expect((await bridge.waitForResponse("turn-1")).error).toBeUndefined();
  expect((await bridge.waitForResponse("steer-1")).error).toBeUndefined();
});

it("holds a steer sent while the context is fetched, then delivers it after the turn's input to the resident session", async () => {
  await startThread(bridge);
  const resident = queryCalls()[0]!.prompt[Symbol.asyncIterator]();
  const text = async () => {
    const next = await resident.next();
    return (next.value as SDKUserMessage).message.content;
  };
  sendTurn(bridge, "turn-1", "Original request");
  const call = await waitForToolCall(bridge);
  sendTurn(bridge, "steer-1", "First correction", "turn/steer");
  sendTurn(bridge, "steer-2", "Second correction", "turn/steer");
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  answerToolCall(call, "{}");
  expect(await text()).toBe("Original request");
  expect(await text()).toBe("First correction");
  expect(await text()).toBe("Second correction");
  for (const id of ["turn-1", "steer-1", "steer-2"])
    expect((await bridge.waitForResponse(id)).error).toBeUndefined();
});

it("cancels the context fetch on interrupt: the turn and its held steer fail at once", async () => {
  await startThread(bridge);
  sendTurn(bridge, "turn-1", "Original request");
  const call = await waitForToolCall(bridge);
  sendTurn(bridge, "steer-1", "Correction", "turn/steer");
  bridge.sendRequest("interrupt", "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    intent: "interrupt",
    activeTurnId: null,
  });
  await bridge.waitForResponse("interrupt");
  expect((await bridge.waitForResponse("turn-1")).error).toBeDefined();
  expect((await bridge.waitForResponse("steer-1")).error).toBeDefined();
  expect(
    trackers[0]!.handleToolCallResponse({
      jsonrpc: "2.0",
      id: call.id!,
      result: { success: true, contentItems: [] },
    } as never),
  ).toBe(false);
  expect(queryCalls()).toHaveLength(1);
});

it("fails a turn whose context request timed out, without running it in the resident, and ignores the late answer", async () => {
  const first = await startThread(bridge);
  const resident = queryCalls()[0]!;
  vi.useFakeTimers();
  try {
    sendTurn(bridge, "turn-1", "Original request");
    for (let tick = 0; tick < 30; tick++) await Promise.resolve();
    const call = bridge.messages.find(
      (message) =>
        message.method === "item/tool/call" && !answered.has(message.id!),
    )!;
    expect(call).toBeDefined();
    await vi.advanceTimersByTimeAsync(TURN_CONTEXT_TIMEOUT_MS - 1_000);
    expect(
      bridge.messages.some(
        (message) => message.id === "turn-1" && message.method === undefined,
      ),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await bridge.waitForResponse("turn-1")).error?.message).toBe(
      "Claude Code could not get the turn's memory context: no answer within 120 s",
    );
    answered.add(call.id!);
    expect(
      trackers[0]!.handleToolCallResponse({
        jsonrpc: "2.0",
        id: call.id!,
        result: {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                session: "fresh",
                sessionId: FRESH_SESSION_ID,
                systemPrompt: "",
                input: "late",
              }),
            },
          ],
        },
      } as never),
    ).toBe(false);
    expect(queryCalls()).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
  sendTurn(bridge, "turn-2", "Again", "turn/start", SECOND_REQUEST);
  const second = await waitForToolCall(bridge);
  expect(second.params).toMatchObject({
    arguments: { sessionId: first },
  });
  answerToolCall(second, "{}");
  expect(await nextPromptText(resident)).toBe("Again");
  await bridge.waitForResponse("turn-2");
});

function failingQuery() {
  const query = controlledQuery();
  let fail: (error: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  query[Symbol.asyncIterator] = () => ({
    next: async () => failed,
    return: async () => ({ value: undefined, done: true as const }),
  });
  return { query, fail };
}

async function nextTexts(call: QueryCall, count: number): Promise<unknown[]> {
  const prompts = call.prompt[Symbol.asyncIterator]();
  const texts: unknown[] = [];
  for (let n = 0; n < count; n++) {
    texts.push(
      ((await prompts.next()).value as SDKUserMessage).message.content,
    );
  }
  return texts;
}

it("restarts a resident session whose stream ended during preparation, then delivers the turn's input and its held steers there, in order", async () => {
  const first = await startThread(bridge);
  sendTurn(bridge, "turn-1", "Original request");
  const call = await waitForToolCall(bridge);
  sendTurn(bridge, "steer-1", "First correction", "turn/steer");
  sendTurn(bridge, "steer-2", "Second correction", "turn/steer");
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  queryMock.mock.results[0]!.value.close();
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  expect(queryCalls()).toHaveLength(1);
  answerToolCall(call, "{}");
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(2));
  const restarted = queryCalls()[1]!;
  expect(restarted.options.resume).toBe(first);
  expect(await nextTexts(restarted, 3)).toEqual([
    "Original request",
    "First correction",
    "Second correction",
  ]);
  for (const id of ["turn-1", "steer-1", "steer-2"])
    expect((await bridge.waitForResponse(id)).error).toBeUndefined();

  sendTurn(bridge, "turn-2", "Next", "turn/start", SECOND_REQUEST);
  const second = await waitForToolCall(bridge);
  expect(second.params).toMatchObject({ arguments: { sessionId: first } });
  answerToolCall(second, "{}");
  expect(await nextPromptText(restarted)).toBe("Next");
  await bridge.waitForResponse("turn-2");
});

it("fails the turn's input and its held steers together when the resident's stream failed during preparation", async () => {
  const resident = failingQuery();
  queryMock.mockReturnValueOnce(resident.query);
  await startThread(bridge);
  sendTurn(bridge, "turn-1", "Original request");
  const call = await waitForToolCall(bridge);
  sendTurn(bridge, "steer-1", "Correction", "turn/steer");
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  resident.fail(new Error("Claude Code process exited with code 1"));
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  answerToolCall(call, "{}");
  expect((await bridge.waitForResponse("turn-1")).error).toBeDefined();
  expect((await bridge.waitForResponse("steer-1")).error).toBeDefined();
  expect(queryCalls()).toHaveLength(1);
});

it("keeps the resident session until the fresh one has initialized: a CLI that fails to start fails the turn and its held steer", async () => {
  const first = await startThread(bridge);
  const resident = queryCalls()[0]!;
  const failingCli = (args: QueryCall) =>
    sdk.query({
      ...args,
      options: { ...args.options, pathToClaudeCodeExecutable: "/bin/false" },
    });
  queryMock
    .mockImplementationOnce(failingCli)
    .mockImplementationOnce(failingCli);
  sendTurn(bridge, "turn-1", "Original request");
  const call = await waitForToolCall(bridge);
  sendTurn(bridge, "steer-1", "Correction", "turn/steer");
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  answerToolCall(
    call,
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "memory",
      input: "Framed",
    }),
  );
  for (const id of ["turn-1", "steer-1"])
    expect((await bridge.waitForResponse(id)).error).toBeDefined();
  expect(queryMock.mock.results[1]!.type).toBe("return");
  expect(queryMock.mock.results[2]!.type).toBe("return");
  expect(queryMock.mock.results[0]!.value.close).not.toHaveBeenCalled();
  expect(
    bridge.messages.filter(
      (message) =>
        message.method === "thread/identity" &&
        JSON.stringify(message.params).includes(FRESH_SESSION_ID),
    ),
  ).toEqual([]);

  sendTurn(bridge, "turn-2", "Again", "turn/start", SECOND_REQUEST);
  const second = await waitForToolCall(bridge);
  expect(second.params).toMatchObject({
    arguments: { sessionId: first },
  });
  answerToolCall(second, "{}");
  expect(await nextPromptText(resident)).toBe("Again");
  await bridge.waitForResponse("turn-2");
}, 20_000);

it("stops a fresh session still initializing when the turn is interrupted", async () => {
  await startThread(bridge);
  const initializing = controlledQuery();
  initializing.initializationResult = vi.fn(() => new Promise(() => {}));
  queryMock.mockReturnValueOnce(initializing);
  sendTurn(bridge, "turn-1", "Original request");
  answerToolCall(
    await waitForToolCall(bridge),
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "memory",
      input: "Framed",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(2));
  sendTurn(bridge, "steer-1", "Correction", "turn/steer");
  bridge.sendRequest("interrupt", "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    intent: "interrupt",
    activeTurnId: null,
  });
  await bridge.waitForResponse("interrupt");
  expect((await bridge.waitForResponse("turn-1")).error).toBeDefined();
  expect((await bridge.waitForResponse("steer-1")).error).toBeDefined();
  expect(initializing.close).toHaveBeenCalled();
});

const MCP_PROBE_CLI = fileURLToPath(
  new URL("./fixtures/mcp-probe-claude.mjs", import.meta.url),
);

interface ProbedQuery {
  close: () => void;
  initializationResult: () => Promise<{
    mcpProbe: { list: unknown; call: unknown };
  }>;
  sdkMcpTransports: Map<string, unknown>;
}

async function waitForInitiativeRead(
  bridge: Harness,
): Promise<BridgeJsonRpcOutputMessage> {
  for (let tick = 0; tick < 500; tick++) {
    const call = bridge.messages.find(
      (message) =>
        message.method === "item/tool/call" &&
        !answered.has(message.id!) &&
        (message.params as { tool?: string }).tool === "initiative_read",
    );
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected an initiative_read call");
}

it("gives a fresh session its own MCP server, so it lists and calls the thread's tools while the resident keeps its own until the fresh one has initialized", async () => {
  queryMock.mockImplementation((args: QueryCall) =>
    sdk.query({
      ...args,
      options: {
        ...args.options,
        cwd: "/tmp",
        pathToClaudeCodeExecutable: MCP_PROBE_CLI,
      },
    }),
  );
  await startThread(bridge);
  const resident = queryMock.mock.results[0]!.value as ProbedQuery;
  answerToolCall(await waitForInitiativeRead(bridge), "resident read");
  expect((await resident.initializationResult()).mcpProbe).toMatchObject({
    list: {
      subtype: "success",
      response: {
        mcp_response: {
          result: {
            tools: [expect.objectContaining({ name: "initiative_read" })],
          },
        },
      },
    },
    call: {
      subtype: "success",
      response: {
        mcp_response: {
          result: { content: [{ type: "text", text: "resident read" }] },
        },
      },
    },
  });

  sendTurn(bridge, "turn-1", "Hello");
  answerToolCall(
    await waitForToolCall(bridge),
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "memory",
      input: "Framed",
    }),
  );
  const freshRead = await waitForInitiativeRead(bridge);
  const fresh = queryMock.mock.results[1]!.value as ProbedQuery;
  const residentClose = vi.spyOn(resident, "close");
  expect(residentClose).not.toHaveBeenCalled();
  expect(resident.sdkMcpTransports.size).toBe(1);
  answerToolCall(freshRead, "fresh read");
  expect((await fresh.initializationResult()).mcpProbe).toMatchObject({
    list: {
      subtype: "success",
      response: {
        mcp_response: {
          result: {
            tools: [expect.objectContaining({ name: "initiative_read" })],
          },
        },
      },
    },
    call: {
      subtype: "success",
      response: {
        mcp_response: {
          result: { content: [{ type: "text", text: "fresh read" }] },
        },
      },
    },
  });
  expect(fresh.sdkMcpTransports.size).toBe(1);
  expect((await bridge.waitForResponse("turn-1")).error).toBeUndefined();
  expect(residentClose).toHaveBeenCalled();
  expect(
    bridge.messages
      .filter((message) => message.method === "thread/identity")
      .at(-1)!.params,
  ).toMatchObject({ providerThreadId: FRESH_SESSION_ID });
}, 20_000);

it("keeps the frozen system prompt across Stop and resume, so the resumed session goes on with its memory and can start fresh again", async () => {
  await startThread(bridge);
  sendTurn(bridge, "turn-1", "Hello");
  answerToolCall(
    await waitForToolCall(bridge),
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "frozen memory",
      input: "Framed",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(2));
  expect(await nextPromptText(queryCalls()[1]!)).toBe("Framed");
  await bridge.waitForResponse("turn-1");

  bridge.sendRequest("release", "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: FRESH_SESSION_ID,
    intent: "interrupt",
    activeTurnId: null,
  });
  await bridge.waitForResponse("release");
  bridge.sendRequest("resume", "thread/resume", {
    cwd: "/tmp/worktree",
    instructionMode: "append",
    options: options(),
    threadId: THREAD_ID,
    providerThreadId: FRESH_SESSION_ID,
    dynamicTools,
  });
  await bridge.waitForResponse("resume");
  const resumed = queryCalls()[2]!;
  expect(resumed.options.resume).toBe(FRESH_SESSION_ID);
  expect(resumed.options.systemPrompt).toEqual({
    type: "preset",
    preset: "claude_code",
    append: "BB instructions\n\nfrozen memory",
  });

  sendTurn(bridge, "turn-2", "Next", "turn/start", SECOND_REQUEST);
  const second = await waitForToolCall(bridge);
  expect(second.params).toMatchObject({
    arguments: { sessionId: FRESH_SESSION_ID },
  });
  answerToolCall(
    second,
    JSON.stringify({
      session: "fresh",
      sessionId: HANDOVER_SESSION_ID,
      systemPrompt: "",
      input: "Handover",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(4));
  const handover = queryCalls()[3]!;
  expect(handover.options.sessionId).toBe(HANDOVER_SESSION_ID);
  expect(handover.options.systemPrompt).toEqual({
    type: "preset",
    preset: "claude_code",
    append: "BB instructions",
  });
  expect(await nextPromptText(handover)).toBe("Handover");
  await bridge.waitForResponse("turn-2");
});

async function freshTurn(
  id: `turn-${number}`,
  systemPrompt: string,
  sessionId: string,
  turnOptions = options(),
): Promise<QueryCall> {
  const before = queryCalls().length;
  bridge.sendRequest(id, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    clientRequestId: `creq_${id.at(-1)}bcdefghjk`,
    input: [{ type: "text", text: id, mentions: [] }],
    options: turnOptions,
  });
  answerToolCall(
    await waitForToolCall(bridge),
    JSON.stringify({ session: "fresh", sessionId, systemPrompt, input: id }),
  );
  const find = () =>
    queryCalls()
      .slice(before)
      .find((call) => call.options.sessionId === sessionId);
  await vi.waitFor(() => expect(find()).toBeDefined());
  const fresh = find()!;
  expect(await nextPromptText(fresh)).toBe(id);
  expect((await bridge.waitForResponse(id)).error).toBeUndefined();
  return fresh;
}

const THIRD_SESSION_ID = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";

it("forks every fresh session from one seed while the setup stays the same, so the setup is read from the prompt cache", async () => {
  await startThread(bridge);
  const first = await freshTurn("turn-2", "memory v1", FRESH_SESSION_ID);
  const second = await freshTurn("turn-3", "memory v1", HANDOVER_SESSION_ID);
  expect(seedCalls()).toHaveLength(1);
  const seed = seedCalls()[0]!;
  expect(seed.options).toMatchObject({
    title: "BB OptChat seed",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: "BB instructions\n\nmemory v1",
    },
  });
  expect(seed.options.resume).toBeUndefined();
  for (const [fresh, sessionId] of [
    [first, FRESH_SESSION_ID],
    [second, HANDOVER_SESSION_ID],
  ] as const) {
    expect(fresh.options).toMatchObject({
      resume: seed.options.sessionId,
      forkSession: true,
      sessionId,
    });
  }

  const third = await freshTurn("turn-4", "memory v2", THIRD_SESSION_ID);
  expect(seedCalls()).toHaveLength(2);
  expect(seedCalls()[1]!.options.sessionId).not.toBe(seed.options.sessionId);
  expect(third.options.resume).toBe(seedCalls()[1]!.options.sessionId);
});

it("starts an unforked fresh session when its seed fails", async () => {
  seedQueryMock.mockImplementation((call: QueryCall) =>
    seededQuery(call, "error_during_execution"),
  );
  await startThread(bridge);
  const fresh = await freshTurn("turn-2", "memory", FRESH_SESSION_ID);
  expect(seedCalls()).toHaveLength(1);
  expect(fresh.options.resume).toBeUndefined();
  expect(fresh.options.forkSession).toBeUndefined();
  expect(fresh.options.sessionId).toBe(FRESH_SESSION_ID);
});

it("drops a seed whose fork fails and starts the same fresh session unforked, with its memory and input", async () => {
  await startThread(bridge);
  const forked = await freshTurn("turn-2", "memory", FRESH_SESSION_ID);
  const seed = seedCalls()[0]!.options.sessionId!;
  expect(forked.options.resume).toBe(seed);

  queryMock.mockImplementationOnce(() =>
    failedInitQuery(`No conversation found with session ID: ${seed}`),
  );
  const before = queryCalls().length;
  bridge.sendRequest("turn-3", "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    clientRequestId: "creq_3bcdefghjk",
    input: [{ type: "text", text: "turn-3", mentions: [] }],
    options: options(),
  });
  answerToolCall(
    await waitForToolCall(bridge),
    JSON.stringify({
      session: "fresh",
      sessionId: HANDOVER_SESSION_ID,
      systemPrompt: "memory",
      input: "Framed turn-3",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(before + 2));
  const [failedFork, unforked] = queryCalls().slice(before);
  expect(await nextPromptText(unforked!)).toBe("Framed turn-3");
  expect((await bridge.waitForResponse("turn-3")).error).toBeUndefined();
  expect(failedFork!.options).toMatchObject({
    resume: seed,
    forkSession: true,
    sessionId: HANDOVER_SESSION_ID,
  });
  expect(unforked!.options.resume).toBeUndefined();
  expect(unforked!.options.forkSession).toBeUndefined();
  for (const key of [
    "sessionId",
    "systemPrompt",
    "permissionMode",
    "allowDangerouslySkipPermissions",
    "title",
  ] as const) {
    expect(unforked!.options[key]).toEqual(failedFork!.options[key]);
  }
  expect(unforked!.options.systemPrompt).toEqual({
    type: "preset",
    preset: "claude_code",
    append: "BB instructions\n\nmemory",
  });

  const next = await freshTurn("turn-4", "memory", THIRD_SESSION_ID);
  expect(seedCalls()).toHaveLength(2);
  expect(next.options.resume).toBe(seedCalls()[1]!.options.sessionId);
});

it("makes a new seed when a skill is added, edited or removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-seed-skills-"));
  try {
    const cwd = join(root, "workspace");
    const skills = join(cwd, ".claude", "skills");
    mkdirSync(join(skills, "review"), { recursive: true });
    writeFileSync(join(skills, "review", "SKILL.md"), "description: v1\n");
    const turnOptions = {
      ...options(),
      envVars: { CLAUDE_CONFIG_DIR: join(root, "config") },
    };
    bridge.sendRequest("start", "thread/start", {
      cwd,
      instructionMode: "append",
      options: turnOptions,
      threadId: THREAD_ID,
      dynamicTools,
    });
    await bridge.waitForResponse("start");
    const ids = [FRESH_SESSION_ID, HANDOVER_SESSION_ID];
    let turn = 2;
    const seedsAfterTurn = async () => {
      await freshTurn(`turn-${turn}`, "memory", ids[turn % 2]!, turnOptions);
      turn += 1;
      return seedCalls().length;
    };

    expect(await seedsAfterTurn()).toBe(1);
    expect(await seedsAfterTurn()).toBe(1);
    writeFileSync(
      join(skills, "review", "SKILL.md"),
      "description: v2, longer\n",
    );
    expect(await seedsAfterTurn()).toBe(2);
    mkdirSync(join(skills, "deploy"));
    writeFileSync(join(skills, "deploy", "SKILL.md"), "description: deploy\n");
    expect(await seedsAfterTurn()).toBe(3);
    rmSync(join(skills, "review"), { recursive: true });
    expect(await seedsAfterTurn()).toBe(4);
    expect(await seedsAfterTurn()).toBe(4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("runs a fresh session, and its seed, in the permission mode the turn asks for", async () => {
  bridge.sendRequest("start", "thread/start", {
    cwd: "/tmp/worktree",
    instructionMode: "append",
    options: {
      ...options(),
      permissionMode: "accept-edits",
      permissionScope: "workspace",
      approvalReviewer: "user",
      permissionEscalation: "ask",
    },
    threadId: THREAD_ID,
    dynamicTools,
  });
  await bridge.waitForResponse("start");
  expect(queryCalls()[0]!.options.permissionMode).toBe("acceptEdits");

  const fresh = await freshTurn("turn-2", "memory", FRESH_SESSION_ID, {
    ...options(),
    permissionMode: "full",
    permissionScope: "full",
  });
  expect(seedCalls()[0]!.options.permissionMode).toBe("bypassPermissions");
  expect(fresh.options.permissionMode).toBe("bypassPermissions");
  expect(fresh.options.allowDangerouslySkipPermissions).toBe(true);
});

it("lists tools the plugin marks alwaysLoad with Claude Code's always-load flag", async () => {
  await startThread(bridge, [
    ...dynamicTools,
    {
      name: "initiative_zoom",
      description: "zoom",
      inputSchema: { type: "object" },
      alwaysLoad: true,
    },
  ] as typeof dynamicTools);
  const server = queryCalls()[0]!.options.mcpServers!["bb-bridge"]!;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => [tool.name, tool._meta ?? null])).toEqual([
    ["initiative_read", null],
    ["initiative_zoom", { "anthropic/alwaysLoad": true }],
  ]);
  await client.close();
});

it("advertises that it serves the turn context", async () => {
  bridge.sendRequest("init", "initialize", {
    protocolVersion: 1,
    client: { name: "test", version: "0" },
  });
  const response = await bridge.waitForResponse("init");
  expect(
    (response.result as { capabilities: { turnContext?: boolean } })
      .capabilities.turnContext,
  ).toBe(true);
});

// A471 findings 1-3: whether a turn asks follows the tools BB resolved for
// that turn, on every path that starts one (a queued message, a parent
// notice, Send now), not the tools its session was built with.
it("asks for the turn context when the turn's tools have the hook, though its session was built without it", async () => {
  await startThread(bridge, dynamicTools.slice(1));
  sendTurn(
    bridge,
    "notice",
    "[bb system] Worker finished",
    "turn/start",
    "creq_abcdefghjk",
    dynamicTools,
  );
  const call = await waitForToolCall(bridge);
  expect(call.params).toMatchObject({
    tool: TURN_CONTEXT_TOOL,
    arguments: { protocol: 4, input: "[bb system] Worker finished" },
  });
  answerToolCall(
    call,
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "# Memory",
      input: "New message:\n[bb system] Worker finished",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(2));
  const fresh = queryCalls()[1]!;
  expect(fresh.options.sessionId).toBe(FRESH_SESSION_ID);
  expect(await nextPromptText(fresh)).toBe(
    "New message:\n[bb system] Worker finished",
  );
  expect((await bridge.waitForResponse("notice")).error).toBeUndefined();
});

it("fails a turn whose tools have the hook when the hook fails, though its session was built without it", async () => {
  await startThread(bridge, dynamicTools.slice(1));
  sendTurn(
    bridge,
    "notice",
    "[bb system] Worker finished",
    "turn/start",
    "creq_abcdefghjk",
    dynamicTools,
  );
  answerToolCall(await waitForToolCall(bridge), "no memory", false);
  const response = await bridge.waitForResponse("notice");
  expect(response.error?.message).toContain("no memory");
  expect(queryCalls()).toHaveLength(1);
});

it("runs a turn in its session when the turn's tools no longer have the hook", async () => {
  await startThread(bridge);
  sendTurn(
    bridge,
    "turn-1",
    "Memory is off now",
    "turn/start",
    "creq_abcdefghjk",
    dynamicTools.slice(1),
  );
  expect(await nextPromptText(queryCalls()[0]!)).toBe("Memory is off now");
  expect((await bridge.waitForResponse("turn-1")).error).toBeUndefined();
  expect(bridge.messages.some((m) => m.method === "item/tool/call")).toBe(
    false,
  );
});

// A473 finding 3: a session started for a turn serves that turn's tools.
const memoryTools = [
  dynamicTools[0]!,
  ...["memory_read", "memory_zoom"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    alwaysLoad: true,
  })),
] as typeof dynamicTools;

async function listedTools(call: QueryCall) {
  const server = call.options.mcpServers?.["bb-bridge"];
  if (!server) return null;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => [tool.name, tool._meta ?? null]);
}

async function freshTurnWithTools(
  id: string,
  clientRequestId: string,
  sessionId: string,
  tools: typeof dynamicTools,
): Promise<QueryCall> {
  sendTurn(bridge, id, id, "turn/start", clientRequestId, tools);
  answerToolCall(
    await waitForToolCall(bridge),
    JSON.stringify({
      session: "fresh",
      sessionId,
      systemPrompt: "m",
      input: id,
    }),
  );
  const find = () =>
    queryCalls().find((call) => call.options.sessionId === sessionId);
  await vi.waitFor(() => expect(find()).toBeDefined());
  expect(await nextPromptText(find()!)).toBe(id);
  expect((await bridge.waitForResponse(id)).error).toBeUndefined();
  return find()!;
}

it("gives a fresh session, and its seed, the memory tools of a thread whose memory was enabled after its session was built", async () => {
  await startThread(bridge, []);
  expect(queryCalls()[0]!.options.mcpServers).toBeUndefined();
  const fresh = await freshTurnWithTools(
    "turn-1",
    "creq_abcdefghjk",
    FRESH_SESSION_ID,
    memoryTools,
  );
  const listed = [
    ["memory_read", { "anthropic/alwaysLoad": true }],
    ["memory_zoom", { "anthropic/alwaysLoad": true }],
  ];
  for (const call of [seedCalls()[0]!, fresh]) {
    expect(await listedTools(call)).toEqual(listed);
    expect(call.options.allowedTools).toEqual([
      "mcp__bb-bridge__memory_read",
      "mcp__bb-bridge__memory_zoom",
    ]);
  }
  expect(fresh.options.resume).toBe(seedCalls()[0]!.options.sessionId);

  // Another tool list is another setup: a new seed, with that list.
  const next = await freshTurnWithTools(
    "turn-2",
    SECOND_REQUEST,
    HANDOVER_SESSION_ID,
    [...memoryTools, dynamicTools[1]!],
  );
  expect(seedCalls()).toHaveLength(2);
  expect(next.options.resume).toBe(seedCalls()[1]!.options.sessionId);
  expect(await listedTools(next)).toEqual([
    ...listed,
    ["initiative_read", null],
  ]);
});

it("keeps the thread's tools when the fresh session with the turn's tools fails to start", async () => {
  const providerThreadId = await startThread(bridge, []);
  seedQueryMock.mockImplementationOnce(() => {
    throw new Error("spawn claude ENOENT");
  });
  queryMock.mockImplementationOnce(() => {
    throw new Error("spawn claude ENOENT");
  });
  sendTurn(
    bridge,
    "turn-1",
    "Hello",
    "turn/start",
    "creq_abcdefghjk",
    memoryTools,
  );
  answerToolCall(
    await waitForToolCall(bridge),
    JSON.stringify({
      session: "fresh",
      sessionId: FRESH_SESSION_ID,
      systemPrompt: "m",
      input: "Hello",
    }),
  );
  expect((await bridge.waitForResponse("turn-1")).error?.message).toContain(
    "spawn claude ENOENT",
  );
  // The resident still serves the tools it was built with, so BB resuming
  // the thread with those tools keeps it.
  const started = queryCalls().length;
  bridge.sendRequest("resume", "thread/resume", {
    cwd: "/tmp/worktree",
    instructionMode: "append",
    options: options(),
    threadId: THREAD_ID,
    providerThreadId,
    dynamicTools: [],
  });
  expect((await bridge.waitForResponse("resume")).error).toBeUndefined();
  expect(queryCalls()).toHaveLength(started);
});
