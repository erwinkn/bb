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
    end() {
      closed = true;
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
const prompts: Array<{ sessionId: string; content: unknown }> = [];

async function drain(
  sessionId: string,
  prompt: AsyncIterable<SDKUserMessage>,
): Promise<void> {
  for await (const message of prompt) {
    prompts.push({ sessionId, content: message.message.content });
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

interface TaskShape {
  backgrounded?: boolean;
  taskType?: string;
  description?: string;
}

function startBackgroundCommand(
  query: ScriptedQuery,
  taskId: string,
  {
    backgrounded = true,
    taskType = "local_bash",
    description = "Collect slots",
  }: TaskShape = {},
): void {
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
    description,
    task_type: taskType,
    is_backgrounded: backgrounded,
  });
}

function warnings() {
  return assembleCapturedThreadEvents(bridge.messages, "claude-code").flatMap(
    (event) =>
      event.type === "provider/warning"
        ? [
            {
              scope: event.scope.kind,
              summary: event.summary,
              details: event.details,
            },
          ]
        : [],
  );
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
  prompts.length = 0;
  queryMock.mockImplementation((call: QueryCall) => {
    const query = scriptedQuery(call.options.sessionId ?? THREAD_ID);
    queries.push(query);
    void drain(query.sessionId, call.prompt);
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

async function freshSessionWithRunningCommand(
  shape: TaskShape = {},
): Promise<ScriptedQuery> {
  await startThread(true);
  sendTurn("turn-1", "clean up slots", "creq_abcdefghjk");
  await answerFresh(FRESH_SESSION_A);
  await bridge.waitForResponse("turn-1");
  const sessionA = queries.find(
    (query) => query.sessionId === FRESH_SESSION_A,
  )!;
  startBackgroundCommand(sessionA, "bslotgc1", shape);
  await waitForTaskStart("bslotgc1");
  sessionA.push({ type: "result", subtype: "success", is_error: false });
  return sessionA;
}

it("keeps the session that runs a background command when the next turn asks for a fresh one", async () => {
  const sessionA = await freshSessionWithRunningCommand();

  sendTurn("turn-2", "and now?", "creq_bcdefghjkm");
  await answerFresh(FRESH_SESSION_B);
  expect((await bridge.waitForResponse("turn-2")).error).toBeUndefined();

  await vi.waitFor(() =>
    expect(prompts.at(-1)).toEqual({
      sessionId: FRESH_SESSION_A,
      content: "and now?",
    }),
  );
  expect(queries.some((query) => query.sessionId === FRESH_SESSION_B)).toBe(
    false,
  );
  expect(sessionA.close).not.toHaveBeenCalled();
  expect(taskEvents("bslotgc1")).toEqual([
    { type: "item/started", taskStatus: "running" },
  ]);
  expect(
    bridge.messages.some(
      (message) =>
        message.method === "thread/identity" &&
        JSON.stringify(message.params).includes(FRESH_SESSION_B),
    ),
  ).toBe(false);
  expect(warnings()).toEqual([
    {
      scope: "turn",
      summary: "Kept the running session for background work",
      details:
        'A fresh session would stop "Collect slots". Turns keep this session, without a new memory view, until that work ends.',
    },
  ]);

  sessionA.push({ type: "result", subtype: "success", is_error: false });
  sendTurn("turn-3", "still there?", "creq_cdefghjkmn");
  await answerFresh(FRESH_SESSION_B);
  expect((await bridge.waitForResponse("turn-3")).error).toBeUndefined();
  await vi.waitFor(() =>
    expect(prompts.at(-1)).toEqual({
      sessionId: FRESH_SESSION_A,
      content: "still there?",
    }),
  );
  expect(warnings()).toHaveLength(1);

  startBackgroundCommand(sessionA, "bdevsrv1", { description: "Run dev" });
  await waitForTaskStart("bdevsrv1");
  sessionA.push({
    type: "system",
    subtype: "task_notification",
    task_id: "bslotgc1",
    tool_use_id: "toolu_bslotgc1",
    status: "completed",
    output_file: "",
    summary: "done",
  });
  sessionA.push({ type: "result", subtype: "success", is_error: false });
  await vi.waitFor(() =>
    expect(taskEvents("bslotgc1")).toContainEqual(
      expect.objectContaining({ type: "item/backgroundTask/completed" }),
    ),
  );
  sendTurn("turn-4", "and the server?", "creq_defghjkmnp");
  await answerFresh(FRESH_SESSION_B);
  expect((await bridge.waitForResponse("turn-4")).error).toBeUndefined();
  await vi.waitFor(() =>
    expect(prompts.at(-1)).toEqual({
      sessionId: FRESH_SESSION_A,
      content: "and the server?",
    }),
  );
  expect(warnings().at(-1)).toEqual({
    scope: "turn",
    summary: "Kept the running session for background work",
    details:
      'A fresh session would stop "Run dev". Turns keep this session, without a new memory view, until that work ends.',
  });
  expect(warnings()).toHaveLength(2);
});

it("keeps the session that runs a workflow, backgrounded or not", async () => {
  const sessionA = await freshSessionWithRunningCommand({
    backgrounded: false,
    taskType: "local_workflow",
  });

  sendTurn("turn-2", "and now?", "creq_bcdefghjkm");
  await answerFresh(FRESH_SESSION_B);
  expect((await bridge.waitForResponse("turn-2")).error).toBeUndefined();

  expect(sessionA.close).not.toHaveBeenCalled();
  expect(queries.some((query) => query.sessionId === FRESH_SESSION_B)).toBe(
    false,
  );
});

it("swaps in the fresh session when the old session's stream ends while the turn asks for its context", async () => {
  const sessionA = await freshSessionWithRunningCommand();

  sendTurn("turn-2", "and now?", "creq_bcdefghjkm");
  await waitForToolCall();
  sessionA.end();
  await answerFresh(FRESH_SESSION_B);
  expect((await bridge.waitForResponse("turn-2")).error).toBeUndefined();

  expect(queries.some((query) => query.sessionId === FRESH_SESSION_B)).toBe(
    true,
  );
  expect(warnings()).toEqual([]);
});

it("swaps in the fresh session once the background command has finished", async () => {
  const sessionA = await freshSessionWithRunningCommand();
  sessionA.push({
    type: "system",
    subtype: "task_notification",
    task_id: "bslotgc1",
    tool_use_id: "toolu_bslotgc1",
    status: "completed",
    output_file: "",
    summary: "done",
  });
  await vi.waitFor(() => expect(taskEvents("bslotgc1")).toHaveLength(2));

  sendTurn("turn-2", "and now?", "creq_bcdefghjkm");
  await answerFresh(FRESH_SESSION_B);
  expect((await bridge.waitForResponse("turn-2")).error).toBeUndefined();

  expect(sessionA.close).toHaveBeenCalled();
  expect(queries.some((query) => query.sessionId === FRESH_SESSION_B)).toBe(
    true,
  );
  expect(taskEvents("bslotgc1")).toEqual([
    { type: "item/started", taskStatus: "running" },
    { type: "item/backgroundTask/completed", taskStatus: "completed" },
  ]);
});

it("settles the old session's leftover foreground task before a fresh session's identity", async () => {
  const sessionA = await freshSessionWithRunningCommand({
    backgrounded: false,
  });

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
