import {
  getQueuedThreadMessage,
  getThread,
  type ClaimedQueuedThreadMessageRow,
} from "@bb/db";
import type {
  PromptInput,
  QueuedMessageWaitingOn,
  ResolvedThreadExecutionOptions,
  Thread,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import {
  intendedThreadEnvironmentIntent,
  intendedThreadHostId,
  resolveDispatchAttemptKind,
} from "./dispatch-attempt.js";
import {
  dispatchExecutionSources,
  dispatchWaitReasonForPass,
  hasMessageDispatchHooks,
  noteDispatchRequeued,
  runMessageDispatchHookPass,
} from "./dispatch-hooks.js";
import type { ParentSystemMessageTaxonomy } from "./parent-system-messages.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { recordQueuedMessageWait } from "./queue-waits.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { getActiveTurnId } from "./thread-events.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";
import { toThreadResponseFromThread } from "./thread-runtime-display.js";
import { isPreStartThreadStatus } from "./thread-status.js";

interface AdmitParentSystemNoticeArgs extends ParentSystemMessageTaxonomy {
  claimed: readonly ClaimedQueuedThreadMessageRow[] | null;
  input: PromptInput[];
  thread: Thread;
}

export type ParentSystemNoticeAdmission =
  | { kind: "deliver"; thread: Thread }
  | { kind: "held" }
  | { kind: "gone" };

type ChangedAdmission = { kind: "changed"; thread: Thread };

type Settlement =
  | { kind: "deliver"; thread: Thread }
  | { kind: "wait"; waitingOn: QueuedMessageWaitingOn }
  | { kind: "changed"; thread: Thread }
  | { kind: "gone" };

export function isDispatchHookRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.body.code === "dispatch_rejected" ||
      error.body.code === "dispatch_hook_failed")
  );
}

export async function admitParentSystemNotice(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AdmitParentSystemNoticeArgs,
): Promise<ParentSystemNoticeAdmission> {
  if (!hasMessageDispatchHooks()) {
    return { kind: "deliver", thread: args.thread };
  }
  const first = await runAdmissionPass(deps, args, args.thread);
  if (first.kind !== "changed") return first;
  const second = await runAdmissionPass(deps, args, first.thread);
  if (second.kind !== "changed") return second;
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: second.thread.id },
  );
  const held = hold(deps, args, {
    execution,
    sendAt: null,
    thread: second.thread,
    waitingOn: { kind: "thread-busy" },
  });
  requestQueuedMessageDispatch(deps, {
    kind: "thread-ready",
    threadId: second.thread.id,
  });
  return held;
}

async function runAdmissionPass(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AdmitParentSystemNoticeArgs,
  thread: Thread,
): Promise<ParentSystemNoticeAdmission | ChangedAdmission> {
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: thread.id },
  );
  const turnId = getActiveTurnId(deps, thread.id);
  const settled: {
    value: ParentSystemNoticeAdmission | ChangedAdmission | null;
  } = { value: null };
  const settle = () =>
    persistSettlement(
      deps,
      args,
      execution,
      thread,
      settleAfterHooks(deps, args, thread, turnId),
    );
  const outcome = await runMessageDispatchHookPass(deps, {
    thread,
    threadResponse: toThreadResponseFromThread(deps, { thread }),
    project: requirePublicProject(deps.db, thread.projectId),
    environmentId: thread.environmentId,
    intendedHostId:
      thread.environmentId !== null
        ? null
        : intendedThreadHostId(deps, thread.id),
    environmentIntent: intendedThreadEnvironmentIntent(deps, thread),
    input: args.input,
    requestedExecution: {
      providerId: thread.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      serviceTier: execution.serviceTier,
      permissionMode: execution.permissionMode,
    },
    executionSources: dispatchExecutionSources({}),
    attempt: resolveDispatchAttemptKind(thread, "auto"),
    initiator: "system",
    senderThreadId: null,
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    parentThreadId: thread.parentThreadId,
    queuedMessages: args.claimed?.map(toThreadQueuedMessage) ?? [],
    pluginSubmission: null,
    continueAfterHooks: async () => {
      settled.value = settle();
    },
  });
  if (outcome.kind === "wait") {
    if (args.claimed !== null) noteDispatchRequeued(thread.id);
    return hold(deps, args, {
      execution,
      sendAt: outcome.waiter.sendAt,
      thread,
      waitingOn: {
        kind: "plugin",
        pluginId: outcome.waiter.pluginId,
        reason: dispatchWaitReasonForPass(outcome),
      },
    });
  }
  return settled.value ?? settle();
}

function persistSettlement(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AdmitParentSystemNoticeArgs,
  execution: ResolvedThreadExecutionOptions,
  thread: Thread,
  settlement: Settlement,
): ParentSystemNoticeAdmission | ChangedAdmission {
  if (settlement.kind !== "wait") return settlement;
  return hold(deps, args, {
    execution,
    sendAt: null,
    thread,
    waitingOn: settlement.waitingOn,
  });
}

function settleAfterHooks(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AdmitParentSystemNoticeArgs,
  thread: Thread,
  turnId: string | null,
): Settlement {
  const current = getThread(deps.db, thread.id);
  if (
    current === null ||
    current.archivedAt !== null ||
    current.deletedAt !== null ||
    !claimStillHeld(deps, args.claimed)
  ) {
    return { kind: "gone" };
  }
  if (
    current.status !== thread.status ||
    getActiveTurnId(deps, thread.id) !== turnId
  ) {
    return { kind: "changed", thread: current };
  }
  if (current.status === "stopping") {
    return { kind: "wait", waitingOn: { kind: "stopping" } };
  }
  if (isPreStartThreadStatus(current.status)) {
    return { kind: "wait", waitingOn: { kind: "provisioning" } };
  }
  if (
    deps.pendingInteractions.hasTurnBoundPendingThreadInteraction(current.id)
  ) {
    return { kind: "wait", waitingOn: { kind: "interaction" } };
  }
  return { kind: "deliver", thread: current };
}

function claimStillHeld(
  deps: LoggedPendingInteractionWorkSessionDeps,
  claimed: readonly ClaimedQueuedThreadMessageRow[] | null,
): boolean {
  if (claimed === null) return true;
  return claimed.every((row) => {
    const current = getQueuedThreadMessage(deps.db, row.id);
    return current !== null && current.claimToken === row.claimToken;
  });
}

interface HoldArgs {
  execution: ResolvedThreadExecutionOptions;
  sendAt: number | null;
  thread: Thread;
  waitingOn: QueuedMessageWaitingOn;
}

function hold(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AdmitParentSystemNoticeArgs,
  hold: HoldArgs,
): ParentSystemNoticeAdmission {
  const entry = recordQueuedMessageWait(deps, {
    thread: hold.thread,
    message: {
      input: args.input,
      execution: hold.execution,
      senderThreadId: null,
      origin: null,
      originPluginId: null,
      requestedBy: null,
      payload: { kind: "inline" },
      systemNotice: {
        kind: args.systemMessageKind,
        subject: args.systemMessageSubject,
      },
    },
    waitingOn: hold.waitingOn,
    sendAt: hold.sendAt,
    claimed: args.claimed,
  });
  return entry === null ? { kind: "gone" } : { kind: "held" };
}
