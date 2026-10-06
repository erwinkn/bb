// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimelineRow } from "@bb/server-contract";
import {
  commandRow,
  conversationRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadProviderContext } from "../thread-provider-context";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

afterEach(cleanup);

function renderTimestampedRowIds(timelineRows: TimelineRow[]): string[] {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadProviderContext.Provider
          value={{ providerId: "echo-agent", pluginId: "echo-provider" }}
        >
          <ThreadTimelineRows
            threadId="thr_main"
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
            timelineRows={timelineRows}
          />
        </ThreadProviderContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return [...container.querySelectorAll("[data-message-time]")].map(
    (time) =>
      time
        .closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id") ?? "",
  );
}

function message(
  role: "user" | "assistant",
  createdAt: number,
  turnId: string,
): TimelineRow {
  return conversationRow({
    id: `${role}-${createdAt}`,
    seq: createdAt,
    role,
    text: role === "user" ? "PROMPT" : "ANSWER",
    createdAt,
    startedAt: createdAt,
    turnId,
  });
}

describe("message timestamps", () => {
  it("marks each user message and the first reply of its turn", () => {
    const ids = renderTimestampedRowIds([
      message("user", 100, "turn-1"),
      message("assistant", 200, "turn-1"),
      commandRow({
        id: "command-300",
        seq: 300,
        command: "echo 300",
        createdAt: 300,
        startedAt: 300,
        turnId: "turn-1",
      }),
      message("assistant", 400, "turn-1"),
      message("user", 500, "turn-2"),
      message("assistant", 600, "turn-2"),
    ]);

    expect(ids).toEqual([
      "user-100",
      "assistant-200",
      "user-500",
      "assistant-600",
    ]);
  });
});
