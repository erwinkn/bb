import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const { queryMock, sdk, trackers } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sdk: { query: null as unknown as (args: unknown) => unknown },
  trackers: [] as Array<{ handleToolCallResponse: (r: never) => boolean }>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  sdk.query = (await importOriginal<{ query: typeof sdk.query }>()).query;
  return {
    query: queryMock,
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

import { handleLine } from "../bridge.js";
import { extendSystemPrompt, parseTurnContext } from "../turn-context.js";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcOutputMessage } from "@get-bb/plugin-sdk/provider-bridge/testing";

interface QueryCall {
  prompt: AsyncIterable<SDKUserMessage>;
  options: {
    allowedTools?: string[];
    resume?: string;
    sessionId?: string;
    systemPrompt?: unknown;
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

function queryCalls(): QueryCall[] {
  return queryMock.mock.calls.map((call) => call[0] as QueryCall);
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
): void {
  bridge.sendRequest(id, method, {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    clientRequestId,
    ...(method === "turn/steer" ? { expectedTurnId: "turn-test" } : {}),
    input: [{ type: "text", text, mentions: [] }],
    options: options(),
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
  expect(fresh!.options.resume).toBeUndefined();
  expect(fresh!.options.sessionId).not.toBe(first);
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

it("lets the session go on when the turn context answers {} or fails", async () => {
  await startThread(bridge);
  const resident = queryCalls()[0]!;
  sendTurn(bridge, "turn-1", "Hello");
  answerToolCall(await waitForToolCall(bridge), "{}");
  expect(await nextPromptText(resident)).toBe("Hello");
  await bridge.waitForResponse("turn-1");

  sendTurn(bridge, "turn-2", "Again");
  answerToolCall(await waitForToolCall(bridge), "plugin threw", false);
  expect(await nextPromptText(resident)).toBe("Again");
  await bridge.waitForResponse("turn-2");
  expect(queryCalls()).toHaveLength(1);
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

it("appends to every system prompt shape and parses a fresh session answer and its acknowledgement", () => {
  const fresh = {
    session: "fresh",
    sessionId: FRESH_SESSION_ID,
    systemPrompt: "",
    input: "x",
  };
  const none = { ack: null, context: null };
  expect(
    extendSystemPrompt({ type: "preset", preset: "claude_code" }, "view"),
  ).toEqual({ type: "preset", preset: "claude_code", append: "view" });
  expect(extendSystemPrompt("base", "view")).toBe("base\n\nview");
  expect(extendSystemPrompt("base", "")).toBe("base");
  expect(parseTurnContext({ content: "{}" })).toEqual(none);
  expect(parseTurnContext({ content: "not json" })).toEqual(none);
  expect(
    parseTurnContext({
      content: JSON.stringify({ ...fresh, ack: "creq_a" }),
      isError: true,
    }),
  ).toEqual(none);
  expect(parseTurnContext({ content: JSON.stringify(fresh) })).toEqual({
    ack: null,
    context: fresh,
  });
  expect(
    parseTurnContext({ content: JSON.stringify({ ...fresh, ack: "creq_a" }) }),
  ).toEqual({ ack: "creq_a", context: fresh });
  expect(
    parseTurnContext({ content: JSON.stringify({ ack: "creq_a" }) }),
  ).toEqual({ ack: "creq_a", context: null });
  expect(
    parseTurnContext({
      content: JSON.stringify({ ...fresh, sessionId: undefined }),
    }),
  ).toEqual(none);
  expect(
    parseTurnContext({
      content: JSON.stringify({ ...fresh, sessionId: "../not-a-session" }),
    }),
  ).toEqual(none);
});

it("reports the session and request it asks for, and runs a fresh session under the id the answer names", async () => {
  const first = await startThread(bridge);
  sendTurn(bridge, "turn-1", "Hello");
  const call = await waitForToolCall(bridge);
  expect(call.params).toMatchObject({
    arguments: {
      protocol: 3,
      input: "Hello",
      requestId: "creq_abcdefghjk",
      sessionId: first,
      reports: [],
    },
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
  expect(second.params).toMatchObject({
    arguments: {
      sessionId: FRESH_SESSION_ID,
      reports: [
        {
          requestId: "creq_abcdefghjk",
          offeredSessionId: FRESH_SESSION_ID,
          outcome: "fresh",
          sessionId: FRESH_SESSION_ID,
        },
      ],
    },
  });
  answerToolCall(second, JSON.stringify({ ack: "creq_abcdefghjk" }));
  await prompts.next();
  await bridge.waitForResponse("turn-2");

  sendTurn(bridge, "turn-3", "Third", "turn/start", "creq_cdefghjkmn");
  const third = await waitForToolCall(bridge);
  expect(third.params).toMatchObject({
    arguments: {
      sessionId: FRESH_SESSION_ID,
      reports: [
        {
          requestId: SECOND_REQUEST,
          offeredSessionId: null,
          outcome: "resident",
          sessionId: FRESH_SESSION_ID,
        },
      ],
    },
  });
  answerToolCall(third, "{}");
  await prompts.next();
  await bridge.waitForResponse("turn-3");
});

it("keeps every report the plugin has not acknowledged, and sends them again, oldest first", async () => {
  await startThread(bridge);
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
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(2));
  const prompts = queryCalls()[1]!.prompt[Symbol.asyncIterator]();
  await prompts.next();
  await bridge.waitForResponse("turn-1");
  const freshReport = {
    requestId: "creq_abcdefghjk",
    offeredSessionId: FRESH_SESSION_ID,
    outcome: "fresh",
    sessionId: FRESH_SESSION_ID,
  };

  sendTurn(bridge, "turn-2", "Leave OptChat", "turn/start", SECOND_REQUEST);
  const second = await waitForToolCall(bridge);
  expect(
    (second.params as { arguments: { reports: unknown } }).arguments.reports,
  ).toEqual([freshReport]);
  answerToolCall(second, "{}");
  await prompts.next();
  await bridge.waitForResponse("turn-2");

  sendTurn(bridge, "turn-3", "Leave OptChat", "turn/start", "creq_cdefghjkmn");
  const third = await waitForToolCall(bridge);
  expect(
    (third.params as { arguments: { reports: unknown } }).arguments.reports,
  ).toEqual([
    freshReport,
    {
      requestId: SECOND_REQUEST,
      offeredSessionId: null,
      outcome: "resident",
      sessionId: FRESH_SESSION_ID,
    },
  ]);
  answerToolCall(
    third,
    JSON.stringify({
      ack: SECOND_REQUEST,
      session: "fresh",
      sessionId: HANDOVER_SESSION_ID,
      systemPrompt: "",
      input: "handover",
    }),
  );
  await vi.waitFor(() => expect(queryCalls()).toHaveLength(3));
  const handover = queryCalls()[2]!.prompt[Symbol.asyncIterator]();
  await handover.next();
  await bridge.waitForResponse("turn-3");

  sendTurn(bridge, "turn-4", "Next", "turn/start", "creq_defghjkmnp");
  const fourth = await waitForToolCall(bridge);
  expect(
    (fourth.params as { arguments: { reports: unknown } }).arguments.reports,
  ).toEqual([
    {
      requestId: "creq_cdefghjkmn",
      offeredSessionId: HANDOVER_SESSION_ID,
      outcome: "fresh",
      sessionId: HANDOVER_SESSION_ID,
    },
  ]);
  answerToolCall(fourth, "{}");
  await handover.next();
  await bridge.waitForResponse("turn-4");
});

it("keeps the resident session, with the turn's own text, when the fresh session fails to start", async () => {
  const first = await startThread(bridge);
  const resident = queryCalls()[0]!;
  queryMock.mockImplementationOnce(() => {
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
  expect(await nextPromptText(resident)).toBe("Hello");
  expect((await bridge.waitForResponse("turn-1")).error).toBeUndefined();
  expect(queryMock.mock.results[0]!.value.close).not.toHaveBeenCalled();

  sendTurn(bridge, "turn-2", "Again");
  const second = await waitForToolCall(bridge);
  expect(second.params).toMatchObject({ arguments: { sessionId: first } });
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

it("forgets a context request that timed out, and ignores its late answer", async () => {
  await startThread(bridge);
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
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await nextPromptText(resident)).toBe("Original request");
    await bridge.waitForResponse("turn-1");
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
  answered.add(call.id!);
  queryMock.mock.results[0]!.value.close();
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
  expect(second.params).toMatchObject({
    arguments: {
      sessionId: first,
      reports: [
        {
          requestId: "creq_abcdefghjk",
          offeredSessionId: null,
          outcome: "resident",
          sessionId: first,
        },
      ],
    },
  });
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
  answered.add(call.id!);
  resident.fail(new Error("Claude Code process exited with code 1"));
  expect((await bridge.waitForResponse("turn-1")).error).toBeDefined();
  expect((await bridge.waitForResponse("steer-1")).error).toBeDefined();
  expect(queryCalls()).toHaveLength(1);
});

it("keeps the resident session until the fresh one has initialized: a CLI that fails to start runs the turn there, and the next ask reports it failed", async () => {
  const first = await startThread(bridge);
  const resident = queryCalls()[0]!;
  queryMock.mockImplementationOnce((args: QueryCall) =>
    sdk.query({
      ...args,
      options: { ...args.options, pathToClaudeCodeExecutable: "/bin/false" },
    }),
  );
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
  expect(await nextTexts(resident, 2)).toEqual([
    "Original request",
    "Correction",
  ]);
  for (const id of ["turn-1", "steer-1"])
    expect((await bridge.waitForResponse(id)).error).toBeUndefined();
  expect(queryMock.mock.results[1]!.type).toBe("return");
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
    arguments: {
      sessionId: first,
      reports: [
        {
          requestId: "creq_abcdefghjk",
          offeredSessionId: FRESH_SESSION_ID,
          outcome: "failed",
          sessionId: first,
        },
      ],
    },
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

it("keeps an unacknowledged report and the frozen system prompt across Stop and resume, so the resumed session can leave OptChat", async () => {
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

  sendTurn(bridge, "turn-2", "Leave OptChat", "turn/start", SECOND_REQUEST);
  const second = await waitForToolCall(bridge);
  expect(second.params).toMatchObject({
    arguments: {
      sessionId: FRESH_SESSION_ID,
      reports: [
        {
          requestId: "creq_abcdefghjk",
          offeredSessionId: FRESH_SESSION_ID,
          outcome: "fresh",
          sessionId: FRESH_SESSION_ID,
        },
      ],
    },
  });
  answerToolCall(
    second,
    JSON.stringify({
      ack: "creq_abcdefghjk",
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
