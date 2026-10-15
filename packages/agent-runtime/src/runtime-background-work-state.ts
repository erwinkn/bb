import {
  backgroundTaskItemStatus,
  isSettledBackgroundTaskStatus,
  threadScope,
  type ThreadEvent,
  type ThreadEventBackgroundTaskItem,
} from "@bb/domain";

interface OpenBackgroundTask {
  item: ThreadEventBackgroundTaskItem;
  providerThreadId: string;
}

export class RuntimeBackgroundWorkState {
  private readonly openTaskIdsByThreadId = new Map<string, Set<string>>();
  private readonly openBackgroundTasksByThreadId = new Map<
    string,
    Map<string, OpenBackgroundTask>
  >();

  clear(): void {
    this.openTaskIdsByThreadId.clear();
    this.openBackgroundTasksByThreadId.clear();
  }

  clearThread(threadId: string): void {
    this.openTaskIdsByThreadId.delete(threadId);
    this.openBackgroundTasksByThreadId.delete(threadId);
  }

  hasOpenBackgroundTask(threadId: string, itemId: string): boolean {
    return (
      this.openBackgroundTasksByThreadId.get(threadId)?.has(itemId) ?? false
    );
  }

  settleThread(threadId: string): ThreadEvent[] {
    const openTasks = this.openBackgroundTasksByThreadId.get(threadId);
    this.clearThread(threadId);
    return [...(openTasks?.values() ?? [])].map(
      ({ item, providerThreadId }) => {
        const taskStatus = isSettledBackgroundTaskStatus(item.taskStatus)
          ? item.taskStatus
          : "stopped";
        return {
          type: "item/backgroundTask/completed",
          threadId,
          providerThreadId,
          scope: threadScope(),
          item: {
            ...item,
            status: backgroundTaskItemStatus(taskStatus),
            taskStatus,
          },
        };
      },
    );
  }

  hasOpenWork(): boolean {
    return this.openTaskIdsByThreadId.size > 0;
  }

  hasOpenThreadWork(threadId: string): boolean {
    return (this.openTaskIdsByThreadId.get(threadId)?.size ?? 0) > 0;
  }

  observe(event: ThreadEvent): void {
    if (
      (event.type === "item/started" ||
        event.type === "item/completed" ||
        event.type === "item/backgroundTask/progress" ||
        event.type === "item/backgroundTask/completed") &&
      event.item.type === "backgroundTask"
    ) {
      this.trackBackgroundTask(
        event.threadId,
        event.providerThreadId,
        event.item,
      );
    }
    if (event.type === "item/started" || event.type === "item/completed") {
      if (
        event.item.type === "backgroundTask" ||
        event.item.type === "delegation"
      ) {
        this.setTaskOpen({
          isOpen: event.item.status === "pending",
          taskId: event.item.id,
          threadId: event.threadId,
        });
      }
      return;
    }

    if (
      event.type === "item/backgroundTask/progress" ||
      event.type === "item/backgroundTask/completed" ||
      event.type === "item/delegation/progress" ||
      event.type === "item/delegation/completed"
    ) {
      this.setTaskOpen({
        isOpen: event.item.status === "pending",
        taskId: event.item.id,
        threadId: event.threadId,
      });
    }
  }

  private trackBackgroundTask(
    threadId: string,
    providerThreadId: string,
    item: ThreadEventBackgroundTaskItem,
  ): void {
    const openTasks = this.openBackgroundTasksByThreadId.get(threadId);
    if (item.status !== "pending") {
      openTasks?.delete(item.id);
      if (openTasks?.size === 0) {
        this.openBackgroundTasksByThreadId.delete(threadId);
      }
      return;
    }
    if (openTasks) {
      openTasks.set(item.id, { item, providerThreadId });
      return;
    }
    this.openBackgroundTasksByThreadId.set(
      threadId,
      new Map([[item.id, { item, providerThreadId }]]),
    );
  }

  private setTaskOpen(args: {
    isOpen: boolean;
    taskId: string;
    threadId: string;
  }): void {
    const openTaskIds = this.openTaskIdsByThreadId.get(args.threadId);
    if (!args.isOpen) {
      if (!openTaskIds) {
        return;
      }
      openTaskIds.delete(args.taskId);
      if (openTaskIds.size === 0) {
        this.openTaskIdsByThreadId.delete(args.threadId);
      }
      return;
    }

    if (openTaskIds) {
      openTaskIds.add(args.taskId);
      return;
    }
    this.openTaskIdsByThreadId.set(args.threadId, new Set([args.taskId]));
  }
}
