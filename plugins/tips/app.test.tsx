// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { TipView } from "./contract.js";

const app = await loadPluginApp(() => import("./app"));

const PROMPT_TIP: TipView = {
  id: "subthreads",
  tone: "blue",
  title: "Run work in parallel",
  body: "Ask bb to spin up subthreads that try three approaches at once.",
  action: {
    kind: "prompt",
    label: "Try it",
    prompt: "Spin up three subthreads. Task: ",
  },
};

const ROUTE_TIP: TipView = {
  id: "phone",
  tone: "rose",
  title: "Check on your agents from your phone",
  body: "The bb mobile app lets you follow threads away from your desk.",
  action: { kind: "route", label: "Get the app", path: "/settings/mobile" },
};

const COMMAND_TIP: TipView = {
  id: "command-palette",
  tone: "rose",
  title: "Do anything from the keyboard",
  body: "Press ⌘⇧P to search bb's commands and settings.",
  action: { kind: "command", label: "Open palette", commandId: "palette.open" },
};

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

function setSectionWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 400,
    width,
    height: 400,
    toJSON: () => ({}),
  });
}

function setCompactLayout(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  setSectionWidth(720);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function section() {
  const registration = app.homepageSections[0];
  if (registration === undefined) throw new Error("missing homepage section");
  return registration;
}

function renderTips(
  tips: readonly TipView[] = [PROMPT_TIP, ROUTE_TIP, COMMAND_TIP],
  options: {
    openAppRoute?: (path: string) => boolean;
    runAppCommand?: (commandId: string) => boolean;
    settings?: Record<string, boolean>;
  } = {},
) {
  return renderSlot(
    section(),
    { projectId: "proj_1" },
    {
      rpc: {
        current: () => ({ tips }),
        setEnabled: () => ({ ok: true }),
        act: () => ({ ok: true }),
      },
      ...options,
    },
  );
}

function methods(slot: ReturnType<typeof renderTips>): string[] {
  return slot.inspection.rpcCalls.map((call) => call.method);
}

function tile(slot: ReturnType<typeof renderTips>, id: string): HTMLElement {
  const element = slot.container.querySelector(`[data-tip-id="${id}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`missing tile ${id}`);
  return element;
}

describe("Tips homepage section", () => {
  it("registers one untitled homepage section", () => {
    expect(app.homepageSections).toHaveLength(1);
    expect(section()).not.toHaveProperty("title");
  });

  it("shows three tips as a feed for the selected project", async () => {
    const slot = renderTips();
    expect(await slot.findByText("Run work in parallel")).toBeTruthy();
    expect(slot.getByRole("region", { name: "Tips" })).toBeTruthy();
    expect(slot.getAllByRole("listitem")).toHaveLength(3);
    expect(
      slot.getByRole("button", {
        name: /Run work in parallel.*Adds prompt to composer$/u,
      }),
    ).toBe(tile(slot, "subthreads"));
    expect(
      slot.getByRole("button", { name: /Opens settings: Get the app$/u }),
    ).toBe(tile(slot, "phone"));
    expect(slot.getByRole("button", { name: /Open palette$/u })).toBe(
      tile(slot, "command-palette"),
    );
    expect(slot.queryByText("Adds prompt")).toBeNull();
    expect(slot.queryByText("Get the app")).toBeNull();
    expect(slot.inspection.rpcCalls[0]).toEqual({
      method: "current",
      input: {
        client: { surface: "web", os: expect.any(String) },
        projectId: "proj_1",
      },
    });
  });

  it("renders nothing and asks for nothing on a phone", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    const slot = renderTips();
    await Promise.resolve();
    expect(methods(slot)).toEqual([]);
    expect(slot.container.textContent).toBe("");
  });

  it("renders nothing in the compact layout", async () => {
    setCompactLayout(true);
    const slot = renderTips();
    await Promise.resolve();
    expect(methods(slot)).toEqual([]);
    expect(slot.queryByRole("region", { name: "Tips" })).toBeNull();
  });

  it("renders nothing when the page is too narrow", async () => {
    setCompactLayout(false);
    setSectionWidth(390);
    const slot = renderTips();
    await Promise.resolve();
    expect(methods(slot)).toEqual([]);
    expect(slot.queryByRole("region", { name: "Tips" })).toBeNull();
  });

  it("asks for nothing while tips are turned off", async () => {
    const slot = renderTips(undefined, { settings: { enabled: false } });
    await Promise.resolve();
    expect(methods(slot)).toEqual([]);
    expect(slot.queryByRole("region", { name: "Tips" })).toBeNull();
  });

  it("previews a prompt tip as the composer placeholder on hover and focus", async () => {
    const slot = renderTips();
    await slot.findByText("Run work in parallel");
    fireEvent.mouseEnter(tile(slot, "subthreads"));
    await waitFor(() =>
      expect(slot.composer.placeholderPreview).toBe(
        "Spin up three subthreads. Task:",
      ),
    );
    fireEvent.mouseLeave(tile(slot, "subthreads"));
    await waitFor(() => expect(slot.composer.placeholderPreview).toBeNull());
    fireEvent.focus(tile(slot, "phone"));
    await Promise.resolve();
    expect(slot.composer.placeholderPreview).toBeNull();
    fireEvent.focus(tile(slot, "subthreads"));
    await waitFor(() =>
      expect(slot.composer.placeholderPreview).not.toBeNull(),
    );
    await slot.setComposerText("my own draft");
    await waitFor(() => expect(slot.composer.placeholderPreview).toBeNull());
  });

  it("fills the composer with a prompt tip, puts the draft in its task slot, and focuses it", async () => {
    const slot = renderTips();
    await slot.findByText("Run work in parallel");
    await slot.setComposerText("  fix the flaky login test ");
    fireEvent.click(tile(slot, "subthreads"));
    expect(slot.composer.text).toBe(
      "Spin up three subthreads. Task: fix the flaky login test",
    );
    expect(slot.composer.focusCount).toBe(1);
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(
      await slot.findByText("Added “Run work in parallel” to the composer"),
    ).toBeTruthy();
    expect(slot.queryByText("In composer")).toBeNull();
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "act",
        input: { id: "subthreads" },
      }),
    );
  });

  it("fills an empty composer with the prompt alone", async () => {
    const slot = renderTips();
    await slot.findByText("Run work in parallel");
    fireEvent.click(tile(slot, "subthreads"));
    expect(slot.composer.text).toBe("Spin up three subthreads. Task: ");
  });

  it("opens a bb page for a route tip", async () => {
    const slot = renderTips(undefined, { openAppRoute: () => true });
    await slot.findByText("Run work in parallel");
    fireEvent.click(tile(slot, "phone"));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "experimental_openAppRoute", path: "/settings/mobile" },
    ]);
    await waitFor(() => expect(methods(slot)).toContain("act"));
  });

  it("does not record the tip when bb refuses the route", async () => {
    const slot = renderTips(undefined, { openAppRoute: () => false });
    await slot.findByText("Run work in parallel");
    fireEvent.click(tile(slot, "phone"));
    expect(methods(slot)).not.toContain("act");
  });

  it("runs the app command for a command tip", async () => {
    const slot = renderTips(undefined, { runAppCommand: () => true });
    await slot.findByText("Run work in parallel");
    fireEvent.click(tile(slot, "command-palette"));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "experimental_runAppCommand", commandId: "palette.open" },
    ]);
    await waitFor(() => expect(methods(slot)).toContain("act"));
  });

  it("turns tips off from Hide tips and undoes it", async () => {
    const slot = renderTips();
    await slot.findByText("Run work in parallel");
    fireEvent.click(slot.getByRole("button", { name: /Hide tips/u }));
    expect(await slot.findByText(/Tips are off\./u)).toBeTruthy();
    expect(
      slot.getByText(/Show tips in the Tips plugin settings/u),
    ).toBeTruthy();
    expect(slot.queryByRole("region", { name: "Tips" })).toBeNull();
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "setEnabled",
      input: { enabled: false },
    });
    fireEvent.click(slot.getByRole("button", { name: "Undo" }));
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "setEnabled",
      input: { enabled: true },
    });
    expect(await slot.findByText("Run work in parallel")).toBeTruthy();
  });

  it("refetches when tips change elsewhere", async () => {
    const slot = renderTips();
    await slot.findByText("Run work in parallel");
    await slot.behavior.emitRealtime("tips-changed", {});
    await waitFor(() => expect(methods(slot)).toEqual(["current", "current"]));
  });
});
