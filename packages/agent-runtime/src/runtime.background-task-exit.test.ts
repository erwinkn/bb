import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import {
  createScriptedEchoProcessLog,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  waitForRuntimeState,
  waitForThreadTurnCompleted,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";
import type { AgentRuntime } from "./types.js";

describe("background tasks of an exited provider process", () => {
  let workspacePath: string;
  const runtimes: AgentRuntime[] = [];

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "bb-runtime-bg-exit-"));
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it("settles an idle thread's open background task as stopped when its bridge dies", async () => {
    const events: ThreadEvent[] = [];
    const processLog = createScriptedEchoProcessLog();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        env: processLog.env,
        onEvent: (event) => events.push(event),
      },
    });
    runtimes.push(runtime);
    await runtime.startThread({
      environmentId: "env-1",
      projectId: "p1",
      providerId: "fake",
      threadId: "t-bg",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_bgexitaaaa",
      input: [promptTextInput({ text: "bg_task" })],
      options: fullRuntimeOptions,
      threadId: "t-bg",
    });
    await waitForThreadTurnCompleted({ events, threadId: "t-bg" });
    expect(runtime.getActiveTurnId("t-bg")).toBeNull();
    expect(runtime.hasOpenBackgroundWork()).toBe(true);
    await expect(
      runtime.stopBackgroundTask({
        threadId: "t-bg",
        itemId: "an-item-that-already-finished",
        taskId: "bg-family-t-bg-1",
      }),
    ).resolves.toEqual({ stopped: false });

    const pid = Number(
      processLog
        .read()
        .find((line) => line.startsWith("spawn:"))
        ?.slice("spawn:".length),
    );
    process.kill(pid, "SIGKILL");

    await waitForRuntimeState({
      label: "the dead bridge's background task settled",
      predicate: () =>
        events.some((event) => event.type === "item/backgroundTask/completed"),
      timeoutMs: 5_000,
    });
    const settled = events.filter(
      (event) => event.type === "item/backgroundTask/completed",
    );
    expect(settled).toMatchObject([
      {
        threadId: "t-bg",
        scope: { kind: "thread" },
        item: {
          type: "backgroundTask",
          description: "scripted background task",
          status: "interrupted",
          taskStatus: "stopped",
        },
      },
    ]);
    expect(runtime.hasOpenBackgroundWork()).toBe(false);
  });
});
