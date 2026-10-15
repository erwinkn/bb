import { getThread, listOpenBackgroundTaskItemRowsForThread } from "@bb/db";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import {
  parseStoredBackgroundTaskItem,
  settleBackgroundTask,
} from "./background-task-reconciliation.js";
import { requireThreadHostCommandEnvironment } from "./thread-command-environment.js";
import { getLastProviderThreadId } from "./thread-events.js";

const BACKGROUND_TASK_STOP_TIMEOUT_MS = 30_000;

type ThreadRow = NonNullable<ReturnType<typeof getThread>>;

export async function stopThreadBackgroundTask(
  deps: AppDeps,
  args: { thread: ThreadRow; itemId: string },
): Promise<void> {
  const { thread, itemId } = args;
  const provider = deps.providerRegistry.get(thread.providerId);
  if (provider?.info.capabilities.supportsBackgroundTaskStop !== true) {
    throw new ApiError(
      409,
      "invalid_request",
      "This thread's provider cannot stop background tasks",
    );
  }
  const [row] = listOpenBackgroundTaskItemRowsForThread(deps.db, {
    threadId: thread.id,
    itemId,
  });
  if (!row) {
    return;
  }
  const taskId = parseStoredBackgroundTaskItem(row)?.familyId;
  if (taskId === undefined) {
    throw new ApiError(
      409,
      "invalid_request",
      "This background task has no provider task id to stop",
    );
  }
  const providerThreadId = getLastProviderThreadId(deps, thread.id);
  if (providerThreadId !== null && row.providerThreadId !== providerThreadId) {
    settleBackgroundTask(deps, { threadId: thread.id, itemId });
    return;
  }
  const environment = requireThreadHostCommandEnvironment({
    db: deps.db,
    thread,
  });
  const result = await runLiveHostCommand(deps, {
    command: {
      type: "thread.backgroundTask.stop",
      environmentId: environment.id,
      threadId: thread.id,
      itemId,
      taskId,
    },
    hostId: environment.hostId,
    timeoutMs: BACKGROUND_TASK_STOP_TIMEOUT_MS,
  });
  if (!result.stopped) {
    settleBackgroundTask(deps, { threadId: thread.id, itemId });
  }
}
