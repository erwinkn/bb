import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const { queryMock, seedQueryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  seedQueryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { options?: { title?: string } }) =>
    args.options?.title === "BB OptChat seed"
      ? seedQueryMock(args)
      : queryMock(args),
  forkSession: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import { handleLine } from "../bridge.js";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcOutputMessage } from "@get-bb/plugin-sdk/provider-bridge/testing";

interface QueryCall {
  prompt: AsyncIterable<SDKUserMessage>;
  options: { sessionId?: string; title?: string };
}

type Harness = ReturnType<typeof createBridgeJsonRpcTestHarness>;
type ScriptedQuery = ReturnType<typeof scriptedQuery>;

const THREAD_ID = "thr_background_tasks";
const TURN_CONTEXT_TOOL = "claude_code_turn_context";
const FRESH_SESSION_A = "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const FRESH_SESSION_B = "9a8b7c6d-5e4f-4321-8fed-cba987654321";

function scriptedQuery(sessionId: string) {
  const queued: unknown[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const release = () => {
    wake?.();
    wake = null;
  };
  return {
    sessionId,
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(() => {
      closed = true;
      release();
    }),
    getContextUsage: vi.fn().mockResolvedValue(null),
    initializationResult: vi
      .fn()
      .mockResolvedValue({ account: {}, models: [] }),
    interrupt: vi.fn(async () => {
      closed = true;
      release();
    }),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    stopTask: vi.fn<(taskId: string) => Promise<void>>(async () => {}),
    push(message: Record<string, unknown>) {
      queued.push({ ...message, session_id: sessionId });
      release();
    },
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<unknown>> => {
          while (queued.length === 0 && !closed) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          if (queued.length > 0) {
            return { value: queued.shift(), done: false };
          }
          return { value: undefined, done: true };
        },
        return: async () => ({ value: undefined, done: true as const }),
      };
    },
  };
}

function seededQuery(call: QueryCall) {
  const query = scriptedQuery(call.options.sessionId ?? "seed");
  void call.prompt[Symbol.asyncIterator]()
    .next()
    .then(() => query.push({ type: "result", subtype: "success" }));
  return query;
}

const queries: ScriptedQuery[] = [];

async function drain(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
  for await (const _message of prompt) {
    continue;
  }
}

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

function tools(withTurnContext: boolean) {
  return withTurnContext
    ? [
        {
          name: TURN_CONTEXT_TOOL,
          description: "hidden",
          inputSchema: { type: "object" },
        },
      ]
    : [];
}

async function startThread(withTurnContext = false): Promise<void> {
  bridge.sendRequest("start", "thread/start", {
    cwd: "/tmp/worktree",
    instructionMode: "append",
    options: options(),
    threadId: THREAD_ID,
    dynamicTools: tools(withTurnContext),
  });
  await bridge.waitForResponse("start");
}

function sendTurn(id: string, text: string, clientRequestId: string): void {
  bridge.sendRequest(id, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    clientRequestId,
    input: [{ type: "text", text, mentions: [] }],
    options: options(),
  });
}

async function waitForToolCall(): Promise<BridgeJsonRpcOutputMessage> {
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

async function answerFresh(sessionId: string): Promise<void> {
  const call = await waitForToolCall();
  answered.add(call.id!);
  handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              session: "fresh",
              sessionId,
              systemPrompt: "",
              input: "go",
            }),
          },
        ],
      },
    }),
  );
}

function startBackgroundCommand(query: ScriptedQuery, taskId: string): void {
  query.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `toolu_${taskId}`,
          name: "Bash",
          input: {
            command: "pnpm slot gc",
            description: "Collect slots",
            run_in_background: true,
          },
        },
      ],
    },
    parent_tool_use_id: null,
  });
  query.push({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: "Collect slots",
    task_type: "local_bash",
    is_backgrounded: true,
  });
}

function taskEvents(taskId: string) {
  return assembleCapturedThreadEvents(bridge.messages, "claude-code").flatMap(
    (event) =>
      (event.type === "item/started" ||
        event.type === "item/backgroundTask/completed") &&
      event.item.type === "backgroundTask" &&
      event.item.familyId === taskId
        ? [{ type: event.type, taskStatus: event.item.taskStatus }]
        : [],
  );
}

async function waitForTaskStart(taskId: string): Promise<void> {
  await vi.waitFor(() =>
    expect(taskEvents(taskId)).toEqual([
      { type: "item/started", taskStatus: "running" },
    ]),
  );
}

async function stopTask(id: string, taskId: string) {
  bridge.sendRequest(id, "thread/backgroundTask/stop", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    taskId,
    providerItemId: `task:${taskId}`,
  });
  return bridge.waitForResponse(id);
}

let bridge: Harness;

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  queryMock.mockImplementation((call: QueryCall) => {
    const query = scriptedQuery(call.options.sessionId ?? THREAD_ID);
    queries.push(query);
    void drain(call.prompt);
    return query;
  });
  seedQueryMock.mockImplementation((call: QueryCall) => seededQuery(call));
  bridge = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  vi.useRealTimers();
  bridge.sendRequest("stop", "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    intent: "interrupt",
    activeTurnId: null,
  });
  await bridge.waitForResponse("stop");
  bridge.restore();
});

it("advertises that it can stop background tasks", async () => {
  bridge.sendRequest("init", "initialize", {
    protocolVersion: 2,
    client: { name: "test", version: "1" },
  });
  const response = await bridge.waitForResponse("init");
  expect(response.result).toMatchObject({
    capabilities: { backgroundTaskStop: true },
  });
});

it("stops a running background command through Claude Code and closes it as stopped", async () => {
  await startThread();
  sendTurn("turn-1", "clean up slots", "creq_abcdefghjk");
  await bridge.waitForResponse("turn-1");
  startBackgroundCommand(queries[0]!, "bslotgc1");
  await waitForTaskStart("bslotgc1");

  expect(
    assembleCapturedThreadEvents(bridge.messages, "claude-code").flatMap(
      (event) =>
        event.type === "item/started" && event.item.type === "backgroundTask"
          ? [event.item.command]
          : [],
    ),
  ).toEqual(["pnpm slot gc"]);

  const response = await stopTask("stop-task", "bslotgc1");

  expect(response.result).toEqual({ stopped: true });
  expect(queries[0]!.stopTask).toHaveBeenCalledWith("bslotgc1");
  expect(taskEvents("bslotgc1")).toEqual([
    { type: "item/started", taskStatus: "running" },
    { type: "item/backgroundTask/completed", taskStatus: "stopped" },
  ]);
});

it("leaves a task that restarted under the same id while Stop was in flight", async () => {
  await startThread();
  sendTurn("turn-1", "clean up slots", "creq_abcdefghjk");
  await bridge.waitForResponse("turn-1");
  startBackgroundCommand(queries[0]!, "bslotgc1");
  await waitForTaskStart("bslotgc1");
  let finishStop: () => void = () => {};
  queries[0]!.stopTask.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
  );

  bridge.sendRequest("stop-task", "thread/backgroundTask/stop", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    taskId: "bslotgc1",
    providerItemId: "task:bslotgc1",
  });
  await vi.waitFor(() =>
    expect(queries[0]!.stopTask).toHaveBeenCalledWith("bslotgc1"),
  );
  queries[0]!.push({
    type: "system",
    subtype: "task_notification",
    task_id: "bslotgc1",
    tool_use_id: "toolu_bslotgc1",
    status: "completed",
    output_file: "",
    summary: "done",
  });
  queries[0]!.push({
    type: "system",
    subtype: "task_started",
    task_id: "bslotgc1",
    tool_use_id: "toolu_bslotgc1",
    description: "Collect slots",
    task_type: "local_bash",
    is_backgrounded: true,
  });
  await vi.waitFor(() => expect(taskEvents("bslotgc1")).toHaveLength(3));
  finishStop();
  const response = await bridge.waitForResponse("stop-task");

  expect(response.result).toEqual({ stopped: true });
  expect(taskEvents("bslotgc1")).toEqual([
    { type: "item/started", taskStatus: "running" },
    { type: "item/backgroundTask/completed", taskStatus: "completed" },
    { type: "item/started", taskStatus: "running" },
  ]);
});

it("does not stop a newer run of the selected task that started before Stop arrived", async () => {
  await startThread();
  sendTurn("turn-1", "clean up slots", "creq_abcdefghjk");
  await bridge.waitForResponse("turn-1");
  startBackgroundCommand(queries[0]!, "bslotgc1");
  await waitForTaskStart("bslotgc1");
  queries[0]!.push({
    type: "system",
    subtype: "task_notification",
    task_id: "bslotgc1",
    tool_use_id: "toolu_bslotgc1",
    status: "completed",
    output_file: "",
    summary: "done",
  });
  startBackgroundCommand(queries[0]!, "bslotgc1");
  await vi.waitFor(() => expect(taskEvents("bslotgc1")).toHaveLength(3));

  bridge.sendRequest("stop-old", "thread/backgroundTask/stop", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    taskId: "bslotgc1",
    providerItemId: "task:bslotgc1",
  });
  const old = await bridge.waitForResponse("stop-old");

  expect(old.result).toEqual({ stopped: false });
  expect(queries[0]!.stopTask).not.toHaveBeenCalled();

  bridge.sendRequest("stop-new", "thread/backgroundTask/stop", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    taskId: "bslotgc1",
    providerItemId: "task:bslotgc1#2",
  });
  const current = await bridge.waitForResponse("stop-new");

  expect(current.result).toEqual({ stopped: true });
  expect(queries[0]!.stopTask).toHaveBeenCalledWith("bslotgc1");
});

it("answers stopped: false for a task the session does not run", async () => {
  await startThread();

  const response = await stopTask("stop-task", "bunknown");

  expect(response.result).toEqual({ stopped: false });
  expect(queries[0]!.stopTask).not.toHaveBeenCalled();
});

it("reports a failed stop and keeps the task running", async () => {
  await startThread();
  sendTurn("turn-1", "clean up slots", "creq_abcdefghjk");
  await bridge.waitForResponse("turn-1");
  startBackgroundCommand(queries[0]!, "bslotgc1");
  await waitForTaskStart("bslotgc1");
  queries[0]!.stopTask.mockRejectedValueOnce(new Error("no such task"));

  const response = await stopTask("stop-task", "bslotgc1");

  expect(response.error?.message).toContain("no such task");
  expect(taskEvents("bslotgc1")).toEqual([
    { type: "item/started", taskStatus: "running" },
  ]);
});

it("settles a command Claude Code stops listing once no finish event follows", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await startThread();
  sendTurn("turn-1", "clean up slots", "creq_abcdefghjk");
  await bridge.waitForResponse("turn-1");
  startBackgroundCommand(queries[0]!, "bslotgc1");
  await waitForTaskStart("bslotgc1");

  queries[0]!.push({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [],
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(taskEvents("bslotgc1")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(taskEvents("bslotgc1")).toEqual([
    { type: "item/started", taskStatus: "running" },
    { type: "item/backgroundTask/completed", taskStatus: "stopped" },
  ]);
});

it("settles the old session's background commands when a turn swaps in a fresh session", async () => {
  await startThread(true);
  sendTurn("turn-1", "clean up slots", "creq_abcdefghjk");
  await answerFresh(FRESH_SESSION_A);
  await bridge.waitForResponse("turn-1");
  const sessionA = queries.find(
    (query) => query.sessionId === FRESH_SESSION_A,
  )!;
  startBackgroundCommand(sessionA, "bslotgc1");
  await waitForTaskStart("bslotgc1");
  sessionA.push({ type: "result", subtype: "success", is_error: false });

  sendTurn("turn-2", "and now?", "creq_bcdefghjkm");
  await answerFresh(FRESH_SESSION_B);
  await bridge.waitForResponse("turn-2");

  expect(sessionA.close).toHaveBeenCalled();
  expect(taskEvents("bslotgc1")).toEqual([
    { type: "item/started", taskStatus: "running" },
    { type: "item/backgroundTask/completed", taskStatus: "stopped" },
  ]);
  const settledAt = bridge.messages.findIndex((message) =>
    JSON.stringify(message.params ?? null).includes('"taskStatus":"stopped"'),
  );
  const identityAt = bridge.messages.findIndex(
    (message) =>
      message.method === "thread/identity" &&
      JSON.stringify(message.params).includes(FRESH_SESSION_B),
  );
  expect(settledAt).toBeGreaterThanOrEqual(0);
  expect(settledAt).toBeLessThan(identityAt);
});
