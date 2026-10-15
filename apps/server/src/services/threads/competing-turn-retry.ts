import {
  hasQueuedRetryOfTurnRequest,
  listStoredClientTurnRequestRowsByKeys,
  type DbNotifier,
  type DbTransaction,
} from "@bb/db";
import {
  resolvedThreadExecutionOptionsSchema,
  type ClientTurnRequestId,
  type PromptInput,
  type Thread,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import { recordQueuedMessageWait } from "./queue-waits.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { parseStoredTurnRequestEvent } from "./thread-events.js";
import { retryChain } from "./turn-failed.js";

export const COMPETING_TURN_RETRY_REASON = "Another turn was starting";

export function queueRetryBehindCompetingTurn(
  deps: { db: DbTransaction; hub: DbNotifier },
  args: { thread: Thread; requestId: ClientTurnRequestId },
): void {
  const { thread } = args;
  if (thread.archivedAt !== null) return;
  try {
    assertThreadHostAcceptsWork(deps.db, thread);
  } catch (error) {
    if (error instanceof ApiError) return;
    throw error;
  }
  const [row] = listStoredClientTurnRequestRowsByKeys(deps.db, {
    keys: [{ threadId: thread.id, requestId: args.requestId }],
  });
  if (row === undefined) return;
  const request = parseStoredTurnRequestEvent(row);
  const execution = resolvedThreadExecutionOptionsSchema.safeParse(
    request.execution,
  ).data;
  if (execution === undefined || request.input.length === 0) return;
  const { attemptNumber, originalRequestId } = retryChain(request);
  if (
    hasQueuedRetryOfTurnRequest(deps.db, {
      threadId: thread.id,
      retryOfTurnRequestId: originalRequestId,
    })
  ) {
    return;
  }
  recordQueuedMessageWait(deps, {
    thread,
    message: {
      input: request.input.map((block): PromptInput => ({
        ...block,
        visibility: "agent-only",
      })),
      execution,
      senderThreadId: null,
      origin: null,
      originPluginId: null,
      requestedBy: null,
      payload: {
        kind: "retry",
        retryOfTurnRequestId: originalRequestId,
        attempt: attemptNumber + 1,
        reason: COMPETING_TURN_RETRY_REASON,
      },
      systemNotice: null,
    },
    waitingOn: { kind: "thread-busy" },
    sendAt: null,
    claimed: null,
  });
}
