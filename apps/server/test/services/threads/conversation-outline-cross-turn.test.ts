import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  THREAD_CONTEXT_CLEAR_OPERATION,
  type CompletedTurnDisplay,
  type Thread,
} from "@bb/domain";
import {
  getLatestStoredConversationOutlineSequence,
  getLatestThreadSequence,
  type DbConnection,
} from "@bb/db";
import {
  buildThreadConversationOutline,
  loadThreadConversationOutline,
} from "../../../src/services/threads/timeline.js";
import {
  appendRows,
  createRandom,
  pick,
  PROVIDER_THREAD_ID,
  randomInteger,
  withTestThread,
  type Random,
  type RowSpec,
  type TestThread,
} from "../../helpers/timeline-cache-fixture.js";

interface PendingRequest {
  requestId: string;
  value: number;
}

interface SessionState {
  closedTurnIds: string[];
  counter: number;
  openMessages: Map<string, { id: string; text: string }>;
  openTasks: { id: string; parentToolCallId: string | null }[];
  openToolCalls: Map<string, string>;
  openTurnIds: string[];
  pendingSteers: Map<string, PendingRequest>;
  queuedRequests: PendingRequest[];
  toolCallIds: string[];
}

const SEEDS = 24;
const STEPS = 140;
const STATUSES = ["active", "active", "idle", "error"] as const;
const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
} as const;

function nextId(state: SessionState, prefix: string): string {
  state.counter += 1;
  return `${prefix}-${state.counter}`;
}

function nextRequest(state: SessionState): PendingRequest {
  state.counter += 1;
  return {
    requestId: encodeClientTurnRequestIdNumber({ value: state.counter }),
    value: state.counter,
  };
}

function requestRow(
  request: PendingRequest,
  target: Record<string, unknown>,
  initiator: "user" | "agent",
): RowSpec {
  return {
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      requestId: request.requestId,
      source: "tell",
      initiator,
      senderThreadId: initiator === "agent" ? "thr_sender" : null,
      input: [{ type: "text", text: `Request ${request.value}` }],
      target,
      request: { method: "turn/start", params: {} },
      execution,
    },
  };
}

function acceptedRow(request: PendingRequest, turnId: string): RowSpec {
  return {
    type: "turn/input/accepted",
    turnId,
    data: { clientRequestId: request.requestId },
  };
}

function itemRow(
  type: "item/started" | "item/completed",
  turnId: string | null,
  item: Record<string, unknown> & { id: string; type: string },
  parentToolCallId: string | null = null,
): RowSpec {
  return {
    type,
    turnId,
    itemId: item.id,
    itemKind: item.type as RowSpec["itemKind"],
    parentToolCallId,
    data: {
      item: parentToolCallId === null ? item : { ...item, parentToolCallId },
    },
  };
}

function deltaRow(
  turnId: string,
  itemId: string,
  delta: string,
  parentToolCallId: string | null = null,
): RowSpec {
  return {
    type: "item/agentMessage/delta",
    turnId,
    itemId,
    parentToolCallId,
    data:
      parentToolCallId === null
        ? { itemId, delta }
        : { itemId, delta, parentToolCallId },
  };
}

function backgroundTask(
  id: string,
  parentToolCallId: string | null,
  status: "pending" | "completed" | "failed" | "interrupted",
) {
  return {
    type: "backgroundTask",
    id,
    taskType: "local_bash",
    description: `Task ${id}`,
    command: "pnpm test",
    status,
    taskStatus:
      status === "pending"
        ? "running"
        : status === "interrupted"
          ? "killed"
          : status,
    skipTranscript: false,
    ...(parentToolCallId === null ? {} : { parentToolCallId }),
  };
}

function rejectedRow(request: PendingRequest): RowSpec {
  return {
    type: "client/turn/rejected",
    data: {
      requestId: request.requestId,
      reason: "turn_not_active",
      message: "Turn ended",
    },
  };
}

function closeTurn(state: SessionState, turnId: string): RowSpec[] {
  state.openTurnIds = state.openTurnIds.filter((id) => id !== turnId);
  state.openMessages.delete(turnId);
  state.closedTurnIds.push(turnId);
  const pending = state.pendingSteers.get(turnId);
  state.pendingSteers.delete(turnId);
  return pending === undefined ? [] : [rejectedRow(pending)];
}

function startTurnRows(state: SessionState, random: Random): RowSpec[] {
  const turnId = nextId(state, "turn");
  state.openTurnIds.push(turnId);
  const queued = state.queuedRequests.shift();
  if (queued !== undefined) {
    return [{ type: "turn/started", turnId }, acceptedRow(queued, turnId)];
  }
  const request = nextRequest(state);
  return [
    requestRow(
      request,
      { kind: "new-turn" },
      random() < 0.8 ? "user" : "agent",
    ),
    { type: "turn/started", turnId },
    acceptedRow(request, turnId),
  ];
}

function backgroundTaskRows(state: SessionState, random: Random): RowSpec[] {
  const task =
    random() < 0.8
      ? state.openTasks.at(-1)
      : state.openTasks[Math.floor(random() * state.openTasks.length)];
  if (task === undefined) return [];
  if (random() < 0.35) {
    return [
      {
        type: "item/backgroundTask/progress",
        itemId: task.id,
        itemKind: "backgroundTask",
        parentToolCallId: task.parentToolCallId,
        providerThreadId: PROVIDER_THREAD_ID,
        data: {
          item: backgroundTask(task.id, task.parentToolCallId, "pending"),
        },
      },
    ];
  }
  state.openTasks = state.openTasks.filter((open) => open !== task);
  return [
    {
      type: "item/backgroundTask/completed",
      itemId: task.id,
      itemKind: "backgroundTask",
      parentToolCallId: task.parentToolCallId,
      providerThreadId: PROVIDER_THREAD_ID,
      data: {
        item: backgroundTask(
          task.id,
          task.parentToolCallId,
          pick(random, ["completed", "completed", "failed", "interrupted"]),
        ),
      },
    },
  ];
}

function turnRows(
  state: SessionState,
  random: Random,
  turnId: string,
): RowSpec[] {
  const choice = random();
  if (choice < 0.3) {
    let message = state.openMessages.get(turnId);
    const rows: RowSpec[] = [];
    if (message === undefined) {
      message = { id: nextId(state, "message"), text: "" };
      state.openMessages.set(turnId, message);
    }
    for (let index = randomInteger(random, 1, 3); index > 0; index -= 1) {
      const delta = random() < 0.3 ? `line ${index}\n` : `word${index} `;
      message.text += delta;
      rows.push(deltaRow(turnId, message.id, delta));
    }
    if (random() < 0.4) {
      state.openMessages.delete(turnId);
      rows.push(
        itemRow("item/completed", turnId, {
          id: message.id,
          type: "agentMessage",
          text: random() < 0.1 ? "" : message.text,
        }),
      );
    }
    return rows;
  }
  if (choice < 0.42) {
    const open = state.openToolCalls.get(turnId);
    if (open === undefined) {
      const id = nextId(state, "tool");
      state.openToolCalls.set(turnId, id);
      state.toolCallIds.push(id);
      return [
        itemRow("item/started", turnId, {
          id,
          type: "toolCall",
          tool: "Agent",
          status: "pending",
        }),
      ];
    }
    if (random() < 0.5) {
      const childId = nextId(state, "child-message");
      return [
        deltaRow(turnId, childId, "child ", open),
        itemRow(
          "item/completed",
          turnId,
          { id: childId, type: "agentMessage", text: "Child answer" },
          open,
        ),
      ];
    }
    state.openToolCalls.delete(turnId);
    return [
      itemRow("item/completed", turnId, {
        id: open,
        type: "toolCall",
        tool: "Agent",
        status: random() < 0.8 ? "completed" : "failed",
      }),
    ];
  }
  if (choice < 0.52) {
    const id = nextId(state, "task");
    const parentToolCallId = random() < 0.7 ? nextId(state, "command") : null;
    state.openTasks.push({ id, parentToolCallId });
    return [
      itemRow(
        "item/started",
        turnId,
        backgroundTask(id, parentToolCallId, "pending"),
        parentToolCallId,
      ),
    ];
  }
  if (choice < 0.6) {
    const request = nextRequest(state);
    const rows = [
      requestRow(request, { kind: "steer", expectedTurnId: turnId }, "user"),
    ];
    const outcome = random();
    if (outcome < 0.6) {
      rows.push(acceptedRow(request, turnId));
    } else if (outcome < 0.75 || state.pendingSteers.has(turnId)) {
      rows.push(rejectedRow(request));
    } else {
      state.pendingSteers.set(turnId, request);
    }
    return rows;
  }
  if (choice < 0.66) {
    const request = nextRequest(state);
    state.queuedRequests.push(request);
    return [
      requestRow(
        request,
        { kind: "new-turn" },
        random() < 0.7 ? "user" : "agent",
      ),
    ];
  }
  if (choice < 0.7) {
    const pending = state.pendingSteers.get(turnId);
    if (pending === undefined) return [];
    state.pendingSteers.delete(turnId);
    return [acceptedRow(pending, turnId)];
  }
  if (choice < 0.73 && state.openTurnIds.length === 1) {
    return startTurnRows(state, random);
  }
  if (choice < 0.75) {
    const parentToolCallId = state.toolCallIds.at(-1);
    if (parentToolCallId === undefined) return [];
    const childTurnId = nextId(state, "child-turn");
    const childMessageId = nextId(state, "child-message");
    return [
      {
        type: "turn/started",
        turnId: childTurnId,
        parentToolCallId,
        data: { parentToolCallId },
      },
      itemRow(
        "item/completed",
        childTurnId,
        { id: childMessageId, type: "agentMessage", text: "Delegated" },
        parentToolCallId,
      ),
      {
        type: "turn/completed",
        turnId: childTurnId,
        data: { status: "completed" },
      },
    ];
  }
  if (choice < 0.93) {
    const rows: RowSpec[] = [];
    const message = state.openMessages.get(turnId);
    if (message !== undefined && random() < 0.8) {
      rows.push(
        itemRow("item/completed", turnId, {
          id: message.id,
          type: "agentMessage",
          text: message.text,
        }),
      );
    }
    rows.push(
      {
        type: "turn/completed",
        turnId,
        data: {
          status: pick(random, [
            "completed",
            "completed",
            "interrupted",
            "failed",
          ]),
        },
      },
      ...closeTurn(state, turnId),
    );
    return rows;
  }
  return [
    { type: "system/thread/interrupted", data: { reason: "manual-stop" } },
    ...[...state.openTurnIds].flatMap((open): RowSpec[] => [
      { type: "turn/completed", turnId: open, data: { status: "interrupted" } },
      ...closeTurn(state, open),
    ]),
  ];
}

function randomRows(state: SessionState, random: Random): RowSpec[] {
  const choice = random();
  if (choice < 0.12 && state.openTasks.length > 0) {
    return backgroundTaskRows(state, random);
  }
  if (choice < 0.14) {
    return [{ type: "system/error", data: { message: "Daemon disconnected" } }];
  }
  if (choice < 0.16) {
    return [
      { type: "system/manager/user_message", data: { text: "Manager update" } },
    ];
  }
  if (choice < 0.165 && state.openTurnIds.length === 0) {
    state.closedTurnIds = [];
    return [
      {
        type: "system/operation",
        data: {
          operation: THREAD_CONTEXT_CLEAR_OPERATION,
          operationId: nextId(state, "clear"),
          status: "completed",
          message: "Context cleared",
        },
      },
    ];
  }
  if (choice < 0.18 && state.closedTurnIds.length > 0) {
    const turnId = pick(random, state.closedTurnIds);
    return [deltaRow(turnId, nextId(state, "late-message"), "late ")];
  }
  if (choice < 0.19 && state.queuedRequests.length > 0) {
    const queued = state.queuedRequests.shift()!;
    return [rejectedRow(queued)];
  }
  const turnId = state.openTurnIds.at(-1);
  if (turnId === undefined) return startTurnRows(state, random);
  return turnRows(state, random, pick(random, state.openTurnIds));
}

function countOutlineRows(db: DbConnection, run: () => void): number {
  const raw = db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  let count = 0;
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);
      if (source.includes("union all") && source.includes("json_remove")) {
        const originalAll = statement.all.bind(statement);
        statement.all = (...params: unknown[]) => {
          const rows = originalAll(...params);
          count += rows.length;
          return rows;
        };
      }
      return statement;
    },
  });
  try {
    run();
  } finally {
    raw.prepare = originalPrepare;
  }
  return count;
}

function compare(
  testThread: TestThread,
  thread: Thread,
  completedTurnDisplay: CompletedTurnDisplay,
  label: string,
): { full: number; incremental: number } {
  const threadId = thread.id;
  const maxSeq = getLatestThreadSequence(testThread.db, { threadId });
  let incremental: ReturnType<typeof loadThreadConversationOutline> | null =
    null;
  const incrementalRows = countOutlineRows(testThread.db, () => {
    incremental = loadThreadConversationOutline(testThread.db, thread, {
      completedTurnDisplay,
      includeClearedContextHistory: false,
      maxSeq,
      outlineSequence: getLatestStoredConversationOutlineSequence(
        testThread.db,
        { threadId },
      ),
    });
  });
  let full: ReturnType<typeof buildThreadConversationOutline> | null = null;
  const fullRows = countOutlineRows(testThread.coldDb, () => {
    full = buildThreadConversationOutline(testThread.coldDb, thread, {
      completedTurnDisplay,
      includeClearedContextHistory: false,
      maxSeq,
    });
  });
  expect(incremental, label).toEqual(full);
  return { full: fullRows, incremental: incrementalRows };
}

function emptySessionState(): SessionState {
  return {
    closedTurnIds: [],
    counter: 0,
    openMessages: new Map(),
    openTasks: [],
    openToolCalls: new Map(),
    openTurnIds: [],
    pendingSteers: new Map(),
    queuedRequests: [],
    toolCallIds: [],
  };
}

function coordinatorTurnRows(
  state: SessionState,
  index: number,
  queued: PendingRequest | null,
): RowSpec[] {
  const turnId = `turn-${index}`;
  const request = queued ?? nextRequest(state);
  const taskId = `task-${index}`;
  const commandId = `command-${index}`;
  return [
    ...(queued === null
      ? [requestRow(request, { kind: "new-turn" }, "user")]
      : []),
    { type: "turn/started", turnId },
    acceptedRow(request, turnId),
    itemRow(
      "item/started",
      turnId,
      backgroundTask(taskId, commandId, "pending"),
      commandId,
    ),
    {
      type: "item/backgroundTask/completed",
      itemId: taskId,
      itemKind: "backgroundTask",
      parentToolCallId: commandId,
      providerThreadId: PROVIDER_THREAD_ID,
      data: { item: backgroundTask(taskId, commandId, "completed") },
    },
    itemRow("item/completed", turnId, {
      id: `message-${index}`,
      type: "agentMessage",
      text: `Answer ${index}`,
    }),
    { type: "turn/completed", turnId, data: { status: "completed" } },
  ];
}

describe("conversation outlines across turn boundaries", () => {
  it("rejects checkpoints in linear time when an early task reports after many turns", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [
        { type: "turn/started", turnId: "turn-0" },
        itemRow(
          "item/started",
          "turn-0",
          backgroundTask("early-task", null, "pending"),
        ),
        {
          type: "turn/completed",
          turnId: "turn-0",
          data: { status: "completed" },
        },
        ...Array.from({ length: 16_000 }, (_, index): RowSpec[] => {
          const turnId = `turn-${index + 1}`;
          return [
            { type: "turn/started", turnId },
            itemRow("item/completed", turnId, {
              id: `message-${index + 1}`,
              type: "agentMessage",
              text: `Answer ${index + 1}`,
            }),
            { type: "turn/completed", turnId, data: { status: "completed" } },
          ];
        }).flat(),
        {
          type: "item/backgroundTask/progress",
          itemId: "early-task",
          itemKind: "backgroundTask",
          providerThreadId: PROVIDER_THREAD_ID,
          data: { item: backgroundTask("early-task", null, "pending") },
        },
      ]);
      const threadId = testThread.thread.id;
      const maxSeq = getLatestThreadSequence(testThread.db, { threadId });
      const fullStart = performance.now();
      const full = buildThreadConversationOutline(
        testThread.coldDb,
        testThread.thread,
        {
          completedTurnDisplay: "collapse",
          includeClearedContextHistory: false,
          maxSeq,
        },
      );
      const fullMs = performance.now() - fullStart;
      const incrementalStart = performance.now();
      const incremental = loadThreadConversationOutline(
        testThread.db,
        testThread.thread,
        {
          completedTurnDisplay: "collapse",
          includeClearedContextHistory: false,
          maxSeq,
          outlineSequence: getLatestStoredConversationOutlineSequence(
            testThread.db,
            { threadId },
          ),
        },
      );
      const incrementalMs = performance.now() - incrementalStart;
      expect(incremental).toEqual(full);
      expect(incrementalMs).toBeLessThan(fullMs * 2 + 100);
    });
  });

  it("rebuilds when a later turn reuses an earlier tool call id", () => {
    withTestThread((testThread) => {
      const state = emptySessionState();
      const message = (turnId: string, id: string): RowSpec =>
        itemRow("item/completed", turnId, {
          id,
          type: "agentMessage",
          text: `Message ${id}`,
        });
      const toolCall = (turnId: string): RowSpec =>
        itemRow("item/started", turnId, {
          id: "reused-tool",
          type: "toolCall",
          tool: "Agent",
          status: "pending",
        });
      const turn = (turnId: string, rows: RowSpec[]): RowSpec[] => {
        const request = nextRequest(state);
        return [
          requestRow(request, { kind: "new-turn" }, "user"),
          { type: "turn/started", turnId },
          acceptedRow(request, turnId),
          ...rows,
          { type: "turn/completed", turnId, data: { status: "completed" } },
        ];
      };
      appendRows(testThread, [
        ...turn("first", [toolCall("first"), message("first", "first-answer")]),
        ...turn("second", [message("second", "second-answer")]),
      ]);
      compare(testThread, testThread.thread, "collapse", "before reuse");
      appendRows(
        testThread,
        turn("third", [
          message("third", "third-early"),
          toolCall("third"),
          message("third", "third-late"),
        ]),
      );
      compare(testThread, testThread.thread, "collapse", "after reuse");
    });
  });

  it("only reads the live tail of a thread with background tasks, ordering boundaries and rejected steers", () => {
    withTestThread((testThread) => {
      const state = emptySessionState();
      const queued = nextRequest(state);
      const steer = nextRequest(state);
      for (let index = 0; index < 60; index += 1) {
        const rows = coordinatorTurnRows(
          state,
          index,
          index === 11 ? queued : null,
        );
        if (index === 10) {
          rows.splice(-1, 0, requestRow(queued, { kind: "new-turn" }, "user"));
        }
        if (index === 20) {
          rows.splice(
            -1,
            0,
            requestRow(
              steer,
              { kind: "steer", expectedTurnId: "turn-20" },
              "user",
            ),
            rejectedRow(steer),
          );
        }
        if (index === 30) {
          rows.splice(
            -1,
            0,
            itemRow(
              "item/started",
              "turn-30",
              backgroundTask("long-task", "long-command", "pending"),
              "long-command",
            ),
          );
        }
        if (index === 32) {
          rows.push({
            type: "item/backgroundTask/completed",
            itemId: "long-task",
            itemKind: "backgroundTask",
            parentToolCallId: "long-command",
            providerThreadId: PROVIDER_THREAD_ID,
            data: {
              item: backgroundTask("long-task", "long-command", "failed"),
            },
          });
        }
        appendRows(testThread, rows);
      }
      const live = nextRequest(state);
      appendRows(testThread, [
        requestRow(live, { kind: "new-turn" }, "user"),
        { type: "turn/started", turnId: "live" },
        acceptedRow(live, "live"),
      ]);
      compare(testThread, testThread.thread, "collapse", "warm-up");
      for (const rows of [
        [deltaRow("live", "message-live", "Streaming")],
        [deltaRow("live", "message-live", " more")],
        [
          itemRow("item/completed", "live", {
            id: "message-live",
            type: "agentMessage",
            text: "Streaming more",
          }),
          {
            type: "turn/completed",
            turnId: "live",
            data: { status: "completed" },
          },
        ],
        coordinatorTurnRows(state, 60, null),
      ] satisfies RowSpec[][]) {
        appendRows(testThread, rows);
        const thread = { ...testThread.thread, status: "active" as const };
        const counts = compare(testThread, thread, "collapse", "live");
        expect(counts.incremental).toBeLessThan(20);
        expect(counts.full).toBeGreaterThan(300);
        const idle = { ...testThread.thread, status: "idle" as const };
        expect(
          compare(testThread, idle, "collapse", "idle").incremental,
        ).toBeLessThan(20);
      }
    });
  });

  it.each(
    Array.from(
      { length: SEEDS },
      (_, seed) => [seed, seed % 4 === 3 ? "flat" : "collapse"] as const,
    ),
  )(
    "matches a full rebuild after every step (seed %i, %s)",
    (seed, completedTurnDisplay) => {
      withTestThread((testThread) => {
        const random = createRandom(seed + 1);
        const state = emptySessionState();
        let reused = 0;
        for (let step = 0; step < STEPS; step += 1) {
          appendRows(testThread, randomRows(state, random));
          const thread = {
            ...testThread.thread,
            status: pick(random, STATUSES),
          };
          const rows = compare(
            testThread,
            thread,
            completedTurnDisplay,
            `seed ${seed} step ${step} status ${thread.status}`,
          );
          if (rows.incremental < rows.full) reused += 1;
        }
        expect(reused).toBeGreaterThan(STEPS / 3);
      });
    },
  );
});
