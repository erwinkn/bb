import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  createClaudeDeltaHarness,
  spawningToolUseMessage,
} from "./delta-test-harness.js";

const THREAD = "bb-thread-1";
const context = { threadId: THREAD };

function startCommand(
  harness: ReturnType<typeof createClaudeDeltaHarness>,
  taskId: string,
  isBackgrounded = true,
): void {
  harness.translate(
    spawningToolUseMessage({
      toolUseId: `toolu_${taskId}`,
      toolName: "Bash",
      input: { command: `sleep 600 # ${taskId}`, run_in_background: true },
    }),
    context,
  );
  harness.translate(
    {
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: `toolu_${taskId}`,
      description: `Wait (${taskId})`,
      task_type: "local_bash",
      is_backgrounded: isBackgrounded,
      session_id: "sess-1",
    },
    context,
  );
}

function liveTasks(taskIds: string[]): Record<string, unknown> {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: taskIds.map((taskId) => ({
      task_id: taskId,
      task_type: "local_bash",
      description: taskId,
    })),
    session_id: "sess-1",
  };
}

function completions(events: ThreadEvent[]) {
  return events.flatMap((event) =>
    event.type === "item/backgroundTask/completed" &&
    event.item.type === "backgroundTask"
      ? [
          {
            familyId: event.item.familyId,
            status: event.item.status,
            taskStatus: event.item.taskStatus,
          },
        ]
      : [],
  );
}

describe("claude-code background task settlement", () => {
  it("settles a command the live task list dropped once its finish event never came", () => {
    const harness = createClaudeDeltaHarness();
    startCommand(harness, "b1");
    startCommand(harness, "b2");

    expect(harness.translate(liveTasks(["b2"]), context)).toEqual([]);
    const missing =
      harness.translator.listBackgroundTasksMissingFromLiveSet(THREAD);
    expect(missing).toEqual(["task:b1"]);

    const settled = harness.assemble(
      harness.translator.settleBackgroundTasksStillMissing(THREAD, missing),
      THREAD,
    );
    expect(completions(settled)).toEqual([
      { familyId: "b1", status: "interrupted", taskStatus: "stopped" },
    ]);
    expect(
      harness.translator.runningBackgroundTaskGeneration(
        THREAD,
        "b1",
        "task:b1",
      ),
    ).toBeNull();
    expect(
      harness.translator.runningBackgroundTaskGeneration(
        THREAD,
        "b2",
        "task:b2",
      ),
    ).toBe(1);
  });

  it("leaves foreground tasks alone, since the live list holds only background ones", () => {
    const harness = createClaudeDeltaHarness();
    startCommand(harness, "f1", false);
    startCommand(harness, "f2", false);
    harness.translate(liveTasks([]), context);

    expect(
      harness.translator.listBackgroundTasksMissingFromLiveSet(THREAD),
    ).toEqual([]);

    harness.translate(
      {
        type: "system",
        subtype: "task_updated",
        task_id: "f2",
        patch: { is_backgrounded: true },
        session_id: "sess-1",
      },
      context,
    );
    harness.translate(liveTasks([]), context);
    expect(
      harness.translator.listBackgroundTasksMissingFromLiveSet(THREAD),
    ).toEqual(["task:f2"]);
  });

  it("carries the command its Bash call ran on the task", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(
      spawningToolUseMessage({
        toolUseId: "toolu_cmd",
        toolName: "Bash",
        input: { command: "pnpm -s slot gc", run_in_background: true },
      }),
      context,
    );
    const started = harness.translate(
      {
        type: "system",
        subtype: "task_started",
        task_id: "bcmd",
        tool_use_id: "toolu_cmd",
        description: "Collect slots",
        task_type: "local_bash",
        is_backgrounded: true,
        session_id: "sess-1",
      },
      context,
    );

    expect(
      started.flatMap((event) =>
        event.type === "item/started" && event.item.type === "backgroundTask"
          ? [event.item.command]
          : [],
      ),
    ).toEqual(["pnpm -s slot gc"]);
  });

  it("does not let a run's missing-task check settle a newer run of the same task id", () => {
    const harness = createClaudeDeltaHarness();
    startCommand(harness, "b1");
    harness.translate(liveTasks([]), context);
    const firstMissing =
      harness.translator.listBackgroundTasksMissingFromLiveSet(THREAD);
    harness.translate(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "b1",
        tool_use_id: "toolu_b1",
        status: "completed",
        output_file: "",
        summary: "done",
        session_id: "sess-1",
      },
      context,
    );
    startCommand(harness, "b1");
    harness.translate(liveTasks([]), context);

    expect(firstMissing).toEqual(["task:b1"]);
    expect(
      harness.translator.settleBackgroundTasksStillMissing(
        THREAD,
        firstMissing,
      ),
    ).toEqual([]);
    expect(
      harness.translator.runningBackgroundTaskGeneration(
        THREAD,
        "b1",
        "task:b1#2",
      ),
    ).toBe(2);
  });

  it("keeps the real result when the finish event follows the live task list", () => {
    const harness = createClaudeDeltaHarness();
    startCommand(harness, "b1");
    harness.translate(liveTasks([]), context);
    const missing =
      harness.translator.listBackgroundTasksMissingFromLiveSet(THREAD);

    const finished = harness.translate(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "b1",
        tool_use_id: "toolu_b1",
        status: "completed",
        output_file: "/tmp/tasks/b1.output",
        summary: "Background command completed (exit code 0)",
        session_id: "sess-1",
      },
      context,
    );

    expect(completions(finished)).toEqual([
      { familyId: "b1", status: "completed", taskStatus: "completed" },
    ]);
    expect(
      harness.translator.settleBackgroundTasksStillMissing(THREAD, missing),
    ).toEqual([]);
  });

  it("keeps a task that the newest live task list reports again", () => {
    const harness = createClaudeDeltaHarness();
    startCommand(harness, "b1");
    harness.translate(liveTasks([]), context);
    const missing =
      harness.translator.listBackgroundTasksMissingFromLiveSet(THREAD);
    harness.translate(liveTasks(["b1"]), context);

    expect(
      harness.translator.settleBackgroundTasksStillMissing(THREAD, missing),
    ).toEqual([]);
    expect(
      harness.translator.runningBackgroundTaskGeneration(
        THREAD,
        "b1",
        "task:b1",
      ),
    ).toBe(1);
  });

  it("reports nothing missing before the session has sent a live task list", () => {
    const harness = createClaudeDeltaHarness();
    startCommand(harness, "b1");

    expect(
      harness.translator.listBackgroundTasksMissingFromLiveSet(THREAD),
    ).toEqual([]);
  });

  it("settles every running task when its session is replaced and forgets the old live task list", () => {
    const harness = createClaudeDeltaHarness();
    startCommand(harness, "b1");
    startCommand(harness, "b2");
    harness.translate(liveTasks(["b1", "b2"]), context);

    const settled = harness.assemble(
      harness.translator.settleBackgroundTasks(THREAD),
      THREAD,
    );

    expect(completions(settled)).toEqual([
      { familyId: "b1", status: "interrupted", taskStatus: "stopped" },
      { familyId: "b2", status: "interrupted", taskStatus: "stopped" },
    ]);
    startCommand(harness, "b3");
    expect(
      harness.translator.listBackgroundTasksMissingFromLiveSet(THREAD),
    ).toEqual([]);
  });

  it("does not close a newer generation of a stopped task", () => {
    const harness = createClaudeDeltaHarness();
    startCommand(harness, "b1");
    harness.translate(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "b1",
        tool_use_id: "toolu_b1",
        status: "completed",
        output_file: "",
        summary: "done",
        session_id: "sess-1",
      },
      context,
    );
    startCommand(harness, "b1");

    expect(
      harness.translator.settleStoppedBackgroundTask(THREAD, "b1", 1),
    ).toEqual([]);
    expect(
      harness.translator.runningBackgroundTaskGeneration(
        THREAD,
        "b1",
        "task:b1",
      ),
    ).toBeNull();
    expect(
      harness.translator.runningBackgroundTaskGeneration(
        THREAD,
        "b1",
        "task:b1#2",
      ),
    ).toBe(2);
  });

  it("closes a stopped task once and ignores the provider's later stop notice", () => {
    const harness = createClaudeDeltaHarness();
    startCommand(harness, "b1");

    const stopped = harness.assemble(
      harness.translator.settleStoppedBackgroundTask(THREAD, "b1", 1),
      THREAD,
    );
    const notice = harness.translate(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "b1",
        tool_use_id: "toolu_b1",
        status: "stopped",
        output_file: "",
        summary: "Background command stopped",
        session_id: "sess-1",
      },
      context,
    );

    expect(completions(stopped)).toEqual([
      { familyId: "b1", status: "interrupted", taskStatus: "stopped" },
    ]);
    expect(completions(notice)).toEqual([]);
  });
});
