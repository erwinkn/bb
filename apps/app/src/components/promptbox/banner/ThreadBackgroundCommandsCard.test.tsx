// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backgroundCommandRow,
  workflowRow,
} from "@/test/fixtures/thread-timeline-rows";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { ThreadBackgroundCommandsCard } from "./ThreadBackgroundCommandsCard";

let resizeObserverCallback: ResizeObserverCallback | null = null;
let resizeObserver: TestResizeObserver | null = null;

class TestResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
    resizeObserver = this;
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

function reportCardWidth(target: Element, width: number): void {
  if (!resizeObserverCallback || !resizeObserver) {
    throw new Error("Expected the background card to observe its width.");
  }
  const callback = resizeObserverCallback;
  const observer = resizeObserver;
  const size: ResizeObserverSize = { inlineSize: width, blockSize: 32 };
  const entry: ResizeObserverEntry = {
    target,
    contentRect: new DOMRect(0, 0, width, 32),
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size],
  };
  act(() => callback([entry], observer));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resizeObserverCallback = null;
  resizeObserver = null;
});

describe("ThreadBackgroundCommandsCard", () => {
  it("summarizes and expands a single background command in compact mode", () => {
    const description = "Poll all CI runs for batching head until completion";
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    function CompactCard() {
      const [isExpanded, setIsExpanded] = useState(false);
      return (
        <CompactViewportOverrideProvider isCompactViewport>
          <ThreadBackgroundCommandsCard
            commands={[
              backgroundCommandRow({
                description,
                startedAt: 1,
                status: "pending",
                taskStatus: "running",
              }),
            ]}
            isExpanded={isExpanded}
            onToggle={() => setIsExpanded((value) => !value)}
          />
        </CompactViewportOverrideProvider>
      );
    }

    render(<CompactCard />);

    const toggle = screen.getByRole("button", {
      name: "Running 1 background command",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(setIntervalSpy).not.toHaveBeenCalled();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(description).textContent).toBe(description);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the card width when a narrow composer sits in a wide viewport", () => {
    const description = "Poll all CI runs for batching head until completion";
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <ThreadBackgroundCommandsCard
          commands={[
            backgroundCommandRow({
              description,
              startedAt: 1,
              status: "pending",
              taskStatus: "running",
            }),
          ]}
          isExpanded={false}
          onToggle={() => {}}
        />
      </CompactViewportOverrideProvider>,
    );

    const card = screen.getByRole("region", { name: "Background commands" });
    expect(
      screen.getByRole("button", {
        name: `Background command: ${description}`,
      }),
    ).not.toBeNull();

    reportCardWidth(card, 320);

    expect(
      screen.getByRole("button", { name: "Running 1 background command" }),
    ).not.toBeNull();
  });

  it("summarizes and expands a single background agent in compact mode", () => {
    const description = "Inspect mobile background banner";

    function CompactCard() {
      const [isExpanded, setIsExpanded] = useState(false);
      return (
        <CompactViewportOverrideProvider isCompactViewport>
          <ThreadBackgroundCommandsCard
            commands={[
              workflowRow({
                description,
                model: "haiku",
                startedAt: 1,
                status: "pending",
                taskStatus: "running",
                taskType: "local_agent",
                workflowName: null,
              }),
            ]}
            isExpanded={isExpanded}
            onToggle={() => setIsExpanded((value) => !value)}
          />
        </CompactViewportOverrideProvider>
      );
    }

    render(<CompactCard />);

    const toggle = screen.getByRole("button", {
      name: "Running 1 background agent",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(description).textContent).toBe(description);
    expect(screen.getByTitle("Model: haiku").textContent).toBe("haiku");
  });

  it("keeps the detailed single-agent summary on wider screens", () => {
    const description = "Inspect mobile background banner";
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <ThreadBackgroundCommandsCard
          commands={[
            workflowRow({
              description,
              model: "haiku",
              startedAt: Date.now() - 2_000,
              status: "pending",
              taskStatus: "running",
              taskType: "local_agent",
              workflowName: null,
            }),
          ]}
          isExpanded={false}
          onToggle={() => {}}
        />
      </CompactViewportOverrideProvider>,
    );

    const item = screen.getByLabelText(
      `Background agent: ${description} · Model haiku`,
    );
    expect(item.textContent).toContain("Running background agent:");
    expect(item.textContent).toContain(description);
    expect(screen.getByTitle("Model: haiku").textContent).toBe("haiku");
    expect(item.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a command's full text and start time when its row is opened", () => {
    const startedAt = new Date(2026, 9, 14, 18, 2, 15).getTime();
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <ThreadBackgroundCommandsCard
          commands={[
            backgroundCommandRow({
              description: "Collect unused slots",
              command: "pnpm -s slot gc 2>&1 | tail -60",
              startedAt,
              status: "pending",
              taskStatus: "running",
            }),
          ]}
          isExpanded
          onToggle={() => {}}
        />
      </CompactViewportOverrideProvider>,
    );

    const row = screen.getByRole("button", {
      name: "Background command: Collect unused slots",
    });
    expect(screen.queryByText("pnpm -s slot gc 2>&1 | tail -60")).toBeNull();

    fireEvent.click(row);

    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("pnpm -s slot gc 2>&1 | tail -60").tagName).toBe(
      "PRE",
    );
    expect(screen.getByText(/^Started /).textContent).toContain(
      new Date(startedAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
  });

  it("takes a collapsed card's rows and Stop buttons out of keyboard reach", () => {
    function Card() {
      const [isExpanded, setIsExpanded] = useState(true);
      return (
        <CompactViewportOverrideProvider isCompactViewport={false}>
          <ThreadBackgroundCommandsCard
            commands={[
              backgroundCommandRow({
                description: "Collect unused slots",
                status: "pending",
                taskStatus: "running",
              }),
            ]}
            isExpanded={isExpanded}
            onToggle={() => setIsExpanded((value) => !value)}
            onStop={() => Promise.resolve()}
          />
        </CompactViewportOverrideProvider>
      );
    }
    render(<Card />);
    const stop = screen.getByRole("button", {
      name: "Stop background command: Collect unused slots",
    });
    expect(stop.closest("[inert]")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Running 1 background command" }),
    );

    expect(stop.closest("[inert]")).not.toBeNull();
  });

  it("has no Stop button when the provider cannot stop background tasks", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <ThreadBackgroundCommandsCard
          commands={[
            backgroundCommandRow({ status: "pending", taskStatus: "running" }),
          ]}
          isExpanded
          onToggle={() => {}}
        />
      </CompactViewportOverrideProvider>,
    );

    expect(screen.queryByRole("button", { name: /^Stop / })).toBeNull();
  });

  it("stops a row, showing it as stopping until the task settles", async () => {
    const onStop = vi.fn(() => new Promise<void>(() => {}));
    const row = backgroundCommandRow({
      description: "Collect unused slots",
      status: "pending",
      taskStatus: "running",
    });
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <ThreadBackgroundCommandsCard
          commands={[row]}
          isExpanded
          onToggle={() => {}}
          onStop={onStop}
        />
      </CompactViewportOverrideProvider>,
    );

    const stop = screen.getByRole("button", {
      name: "Stop background command: Collect unused slots",
    });
    fireEvent.click(stop);

    expect(onStop).toHaveBeenCalledWith(row);
    expect(stop.textContent).toBe("Stopping…");
    expect(stop.hasAttribute("disabled")).toBe(true);
  });

  it("shows why a stop failed and lets the user try again", async () => {
    const onStop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Host is offline"));
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <ThreadBackgroundCommandsCard
          commands={[
            backgroundCommandRow({
              description: "Collect unused slots",
              status: "pending",
              taskStatus: "running",
            }),
          ]}
          isExpanded
          onToggle={() => {}}
          onStop={onStop}
        />
      </CompactViewportOverrideProvider>,
    );

    const stop = screen.getByRole("button", {
      name: "Stop background command: Collect unused slots",
    });
    fireEvent.click(stop);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not stop: Host is offline",
    );
    expect(stop.textContent).toBe("Stop");
    expect(stop.hasAttribute("disabled")).toBe(false);
  });
});
