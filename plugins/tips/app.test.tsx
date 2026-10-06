// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { TipView } from "./contract.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

const PROMPT_TIP: TipView = {
  id: "subthreads",
  title: "Run work in parallel",
  body: "Ask bb to spin up subthreads that try three approaches at once.",
  action: {
    kind: "prompt",
    label: "Try it",
    prompt: "Spin up three subthreads",
  },
};

const ROUTE_TIP: TipView = {
  id: "phone",
  title: "Check on your agents from your phone",
  body: "The bb mobile app lets you follow threads away from your desk.",
  action: { kind: "route", label: "Get the app", path: "/settings/mobile" },
};

const COMMAND_TIP: TipView = {
  id: "command-palette",
  title: "Do anything from the keyboard",
  body: "Press ⌘⇧P to search bb's commands and settings.",
  action: { kind: "command", label: "Open", commandId: "palette.open" },
};

function section() {
  const registration = app.homepageSections[0];
  if (registration === undefined) throw new Error("missing homepage section");
  return registration;
}

function renderTip(
  tip: TipView | null,
  options: {
    openAppRoute?: (path: string) => boolean;
    runAppCommand?: (commandId: string) => boolean;
    settings?: Record<string, boolean>;
  } = {},
) {
  return renderSlot(
    section(),
    { projectId: null },
    {
      rpc: {
        current: () => ({ tip }),
        dismiss: () => ({ ok: true }),
        act: () => ({ ok: true }),
      },
      ...options,
    },
  );
}

function methods(slot: ReturnType<typeof renderTip>): string[] {
  return slot.inspection.rpcCalls.map((call) => call.method);
}

describe("Tips homepage section", () => {
  it("registers one untitled homepage section", () => {
    expect(app.homepageSections).toHaveLength(1);
    expect(section()).not.toHaveProperty("title");
  });

  it("shows the current tip for this client", async () => {
    const slot = renderTip(PROMPT_TIP);
    expect(await slot.findByText("Run work in parallel")).toBeTruthy();
    expect(slot.getByRole("complementary", { name: "Tip" })).toBeTruthy();
    expect(slot.inspection.rpcCalls[0]).toEqual({
      method: "current",
      input: { client: { surface: "web", os: expect.any(String) } },
    });
  });

  it("renders nothing when no tip is due", async () => {
    const slot = renderTip(null);
    await waitFor(() => expect(methods(slot)).toEqual(["current"]));
    expect(slot.queryByRole("complementary", { name: "Tip" })).toBeNull();
  });

  it("asks for nothing while tips are turned off", async () => {
    const slot = renderTip(PROMPT_TIP, { settings: { enabled: false } });
    await Promise.resolve();
    expect(methods(slot)).toEqual([]);
    expect(slot.queryByRole("complementary", { name: "Tip" })).toBeNull();
  });

  it("fills the new-thread composer with a prompt tip and retires it", async () => {
    const slot = renderTip(PROMPT_TIP);
    fireEvent.click(await slot.findByRole("button", { name: "Try it" }));
    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "toCompose",
        options: {
          initialPrompt: "Spin up three subthreads",
          focusPrompt: true,
        },
      },
    ]);
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "act",
        input: { id: "subthreads" },
      }),
    );
    expect(slot.queryByRole("complementary", { name: "Tip" })).toBeNull();
  });

  it("opens a bb page for a route tip", async () => {
    const slot = renderTip(ROUTE_TIP, { openAppRoute: () => true });
    fireEvent.click(await slot.findByRole("button", { name: "Get the app" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "experimental_openAppRoute", path: "/settings/mobile" },
    ]);
    await waitFor(() => expect(methods(slot)).toContain("act"));
  });

  it("keeps the tip when bb refuses the route", async () => {
    const slot = renderTip(ROUTE_TIP, { openAppRoute: () => false });
    fireEvent.click(await slot.findByRole("button", { name: "Get the app" }));
    expect(methods(slot)).not.toContain("act");
    expect(slot.getByRole("complementary", { name: "Tip" })).toBeTruthy();
  });

  it("runs the app command for a command tip", async () => {
    const slot = renderTip(COMMAND_TIP, { runAppCommand: () => true });
    fireEvent.click(await slot.findByRole("button", { name: "Open" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "experimental_runAppCommand", commandId: "palette.open" },
    ]);
    await waitFor(() => expect(methods(slot)).toContain("act"));
  });

  it("dismisses the tip", async () => {
    const slot = renderTip(PROMPT_TIP);
    fireEvent.click(await slot.findByRole("button", { name: "Dismiss tip" }));
    expect(slot.queryByRole("complementary", { name: "Tip" })).toBeNull();
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "dismiss",
        input: { id: "subthreads" },
      }),
    );
  });

  it("refetches when tips change elsewhere", async () => {
    const slot = renderTip(PROMPT_TIP);
    await slot.findByText("Run work in parallel");
    await slot.behavior.emitRealtime("tips-changed", {});
    await waitFor(() => expect(methods(slot)).toEqual(["current", "current"]));
  });
});
