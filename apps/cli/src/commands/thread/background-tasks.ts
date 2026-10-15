import type { Command } from "commander";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson, requireThreadIdOrSelf } from "../helpers.js";

interface ThreadTaskOptions {
  self?: boolean;
  json?: boolean;
}

export function registerBackgroundTaskCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("tasks [id]")
    .description("List the thread's running background commands and agents")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadTaskOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        const timeline = await sdk.threads.timeline({ threadId });
        const tasks = timeline.activeBackgroundCommands.map((row) => ({
          itemId: row.itemId,
          taskType: row.taskType,
          description: row.description,
          command: row.command,
          startedAt: new Date(row.startedAt).toISOString(),
        }));
        if (outputJson(opts, { threadId, tasks })) return;
        if (tasks.length === 0) {
          console.log(`Thread ${threadId} has no running background tasks`);
          return;
        }
        for (const task of tasks) {
          console.log(`${task.itemId}  ${task.startedAt}  ${task.description}`);
          if (task.command !== null && task.command !== task.description) {
            console.log(`  $ ${task.command}`);
          }
        }
      }),
    );

  parent
    .command("stop-task <item-id> [id]")
    .description(
      "Ask the provider to stop one running background task (see bb thread tasks)",
    )
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          itemId: string,
          id: string | undefined,
          opts: ThreadTaskOptions,
        ) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliBbSdk(getUrl());
          await sdk.threads.stopBackgroundTask({ threadId, itemId });
          if (outputJson(opts, { ok: true, threadId, itemId })) return;
          console.log(
            `Background task ${itemId} of thread ${threadId} stopped`,
          );
        },
      ),
    );
}
