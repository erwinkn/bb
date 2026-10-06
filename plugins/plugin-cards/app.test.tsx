// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginCard } from "./server";

let app: Awaited<ReturnType<typeof loadPluginApp>>;

beforeEach(async () => {
  app = await loadPluginApp(() => import("./app"));
});

afterEach(cleanup);

const message = {
  id: "msg_1",
  threadId: "thr_1",
  turnId: "turn_1",
  projectId: "proj_1",
};

function card(overrides: Partial<PluginCard> = {}): PluginCard {
  return {
    pluginId: "browser-automation",
    displayName: "Browser Automation",
    description: "Drive a real browser from any agent.",
    icon: "Globe",
    iconUrl: null,
    iconTinted: false,
    category: "Browser & Web",
    source: { kind: "bundled" },
    installed: true,
    enabled: true,
    compatible: true,
    incompatibleReason: null,
    ...overrides,
  };
}

function renderCard(
  attributes: Record<string, string>,
  getPluginCard: (input: unknown) => unknown,
) {
  return renderSlot(
    app.messageDirectives[0]!,
    {
      attributes,
      source: `::plugin-card{id="${attributes.id ?? ""}"}`,
      message,
      openWorkspaceFile: null,
    },
    { rpc: { getPluginCard }, openPluginDetail: () => true },
  );
}

describe("plugin-card directive", () => {
  it("registers the plugin-card directive", () => {
    expect(app.messageDirectives.map((directive) => directive.id)).toEqual([
      "plugin-card",
    ]);
  });

  it("loads the card, then opens the plugin's detail page from its button", async () => {
    const slot = renderCard({ id: "browser-automation" }, (input) => {
      expect(input).toEqual({ pluginId: "browser-automation" });
      return { kind: "found", card: card() };
    });
    expect(
      slot.getByRole("status", { name: "Loading plugin browser-automation" }),
    ).toBeTruthy();

    const button = await slot.findByRole("button", {
      name: "Open Browser Automation",
    });
    expect(slot.getByText("Drive a real browser from any agent.")).toBeTruthy();
    expect(slot.getByText("Enabled")).toBeTruthy();
    expect(slot.getByText("Browser & Web · Official")).toBeTruthy();

    fireEvent.click(button);
    expect(slot.navigateCalls).toEqual([
      {
        method: "experimental_openPluginDetail",
        pluginId: "browser-automation",
      },
    ]);
  });

  it.each([
    [
      "a disabled plugin",
      card({ enabled: false }),
      "Disabled",
      "Enable",
      "Browser & Web · Official",
    ],
    [
      "a community plugin that is not installed",
      card({ installed: false, enabled: false, source: { kind: "community" } }),
      "Not installed",
      "Install",
      "Browser & Web · BB Community",
    ],
    [
      "an incompatible third-party plugin",
      card({
        installed: false,
        enabled: false,
        compatible: false,
        incompatibleReason: "requires bb 9.0.0",
        source: { kind: "third-party", marketplace: "Acme Plugins" },
      }),
      "Incompatible",
      "Install",
      "Browser & Web · Acme Plugins · Not reviewed by BB",
    ],
    [
      "an uncategorized local plugin",
      card({
        category: null,
        source: { kind: "local", label: "path · /plugins/local-tool" },
      }),
      "Enabled",
      "Open",
      "path · /plugins/local-tool",
    ],
  ])("labels %s", async (_name, pluginCard, status, action, details) => {
    const slot = renderCard({ id: pluginCard.pluginId }, () => ({
      kind: "found",
      card: pluginCard,
    }));
    await slot.findByRole("button", {
      name: `${action} ${pluginCard.displayName}`,
    });
    expect(slot.getByText(status)).toBeTruthy();
    expect(slot.getByText(details)).toBeTruthy();
    expect(slot.navigateCalls).toEqual([]);
  });

  it.each([{}, { id: "" }, { id: "Not An Id" }])(
    "explains a missing or malformed id %j without calling rpc",
    async (attributes) => {
      const slot = renderCard(attributes, () => {
        throw new Error("rpc must not be called");
      });
      expect((await slot.findByRole("alert")).textContent).toContain(
        "needs a plugin id",
      );
      expect(slot.rpcCalls).toEqual([]);
      expect(slot.queryByRole("button")).toBeNull();
    },
  );

  it("shows an unknown id as not found without an action", async () => {
    const slot = renderCard({ id: "nope" }, () => ({
      kind: "not-found",
      pluginId: "nope",
    }));
    expect((await slot.findByRole("alert")).textContent).toContain(
      "No installed or store-listed plugin has the id nope",
    );
    expect(slot.queryByRole("button")).toBeNull();
  });

  it("shows a load failure without an action", async () => {
    const slot = renderCard({ id: "browser-automation" }, () => {
      throw new Error("Connection lost");
    });
    expect((await slot.findByRole("alert")).textContent).toContain(
      "Couldn't load plugin browser-automation: Connection lost",
    );
    expect(slot.queryByRole("button")).toBeNull();
  });
});
