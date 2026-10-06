import { describe, expect, it } from "vitest";
import { TIP_CATALOG, type TipDefinition, type TipSignals } from "./catalog.js";
import { tipViewSchema } from "./contract.js";
import {
  UnknownTipError,
  actOnTip,
  createTipsState,
  deriveSignals,
  dismissTip,
  listTips,
  localDay,
  observeLiveSignals,
  parseTipsState,
  renderTip,
  resetTips,
  selectTip,
  type LiveSignals,
  type TipsState,
} from "./engine.js";

const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 9, 5, 12);

function signals(overrides: Partial<TipSignals> = {}): TipSignals {
  return {
    client: { surface: "web", os: "macos" },
    serverPlatform: "darwin",
    appVersion: "1.0.0",
    firstSeenVersion: "1.0.0",
    daysSinceFirstSeen: 0,
    threadCount: 0,
    availableProviderCount: 1,
    providersUsed: [],
    installedPlugins: {},
    hasFinishedThread: false,
    finishedThreadCount: 0,
    hasChildThread: false,
    hasAutomationThread: false,
    rateLimited: false,
    queuedFollowUp: false,
    usedMobileApp: false,
    ...overrides,
  };
}

function live(overrides: Partial<LiveSignals> = {}): LiveSignals {
  return {
    serverPlatform: "darwin",
    appVersion: "1.0.0",
    threadCount: 0,
    finishedThreadCount: 0,
    hasChildThread: false,
    hasAutomationThread: false,
    providersUsed: [],
    availableProviderCount: 1,
    installedPlugins: {},
    ...overrides,
  };
}

function testTip(
  id: string,
  overrides: Partial<TipDefinition> = {},
): TipDefinition {
  return {
    id,
    title: `Title ${id}`,
    body: `Body ${id}.`,
    action: null,
    priority: 10,
    held: false,
    perVersion: false,
    maxShowDays: 2,
    when: () => true,
    used: () => false,
    ...overrides,
  };
}

function catalogTip(id: string): TipDefinition {
  const definition = TIP_CATALOG.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`missing tip ${id}`);
  return definition;
}

function day(offset: number): string {
  return localDay(START + offset * DAY_MS);
}

function showOn(
  state: TipsState,
  offset: number,
  catalog: readonly TipDefinition[],
  overrides: Partial<TipSignals> = {},
): { state: TipsState; id: string | null } {
  const selection = selectTip(
    state,
    signals(overrides),
    day(offset),
    START + offset * DAY_MS,
    catalog,
  );
  return { state: selection.state, id: selection.tip?.id ?? null };
}

describe("selectTip", () => {
  it("shows the highest-priority eligible tip and keeps it for the rest of the day", () => {
    const catalog = [
      testTip("low", { priority: 1 }),
      testTip("high", { priority: 5 }),
    ];
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    expect(first.id).toBe("high");
    const again = showOn(first.state, 0, catalog);
    expect(again.id).toBe("high");
    expect(again.state.records.high?.shownDays).toBe(1);
  });

  it("shows at most one new tip per day, even after a dismissal", () => {
    const catalog = [
      testTip("a", { priority: 2 }),
      testTip("b", { priority: 1 }),
    ];
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    expect(first.id).toBe("a");
    const dismissed = dismissTip(first.state, "a", "1.0.0", START, catalog);
    expect(showOn(dismissed, 0, catalog).id).toBeNull();
    expect(showOn(dismissed, 1, catalog).id).toBe("b");
  });

  it("rotates to unseen tips before repeating one", () => {
    const catalog = [
      testTip("a", { priority: 3 }),
      testTip("b", { priority: 2 }),
      testTip("c", { priority: 1 }),
    ];
    let state = createTipsState(START, "1.0.0");
    const shown: (string | null)[] = [];
    for (let offset = 0; offset < 4; offset += 1) {
      const result = showOn(state, offset, catalog);
      state = result.state;
      shown.push(result.id);
    }
    expect(shown).toEqual(["a", "b", "c", "a"]);
  });

  it("retires a tip after its maximum number of shown days", () => {
    const catalog = [testTip("only", { maxShowDays: 2 })];
    let state = createTipsState(START, "1.0.0");
    state = showOn(state, 0, catalog).state;
    state = showOn(state, 1, catalog).state;
    const third = showOn(state, 2, catalog);
    expect(third.id).toBeNull();
    expect(third.state.records.only).toMatchObject({
      shownDays: 2,
      retiredReason: "seen",
    });
  });

  it("never shows a dismissed tip again", () => {
    const catalog = [testTip("a")];
    const state = dismissTip(
      createTipsState(START, "1.0.0"),
      "a",
      "1.0.0",
      START,
      catalog,
    );
    for (let offset = 0; offset < 5; offset += 1) {
      expect(showOn(state, offset, catalog).id).toBeNull();
    }
  });

  it("retires a tip for good once its feature is used, even if the signal later reverts", () => {
    const catalog = [
      testTip("feature", { used: (current) => current.hasChildThread }),
    ];
    const used = showOn(createTipsState(START, "1.0.0"), 0, catalog, {
      hasChildThread: true,
    });
    expect(used.id).toBeNull();
    expect(used.state.records.feature?.retiredReason).toBe("used");
    expect(
      showOn(used.state, 1, catalog, { hasChildThread: false }).id,
    ).toBeNull();
  });

  it("drops today's tip when its feature is used mid-day and shows nothing else", () => {
    const catalog = [
      testTip("feature", {
        priority: 5,
        used: (current) => current.queuedFollowUp,
      }),
      testTip("other", { priority: 1 }),
    ];
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    expect(first.id).toBe("feature");
    expect(showOn(first.state, 0, catalog, { queuedFollowUp: true }).id).toBe(
      null,
    );
  });

  it("skips held and ineligible tips", () => {
    const catalog = [
      testTip("held", { priority: 9, held: true }),
      testTip("ineligible", { priority: 8, when: () => false }),
      testTip("shown", { priority: 1 }),
    ];
    expect(showOn(createTipsState(START, "1.0.0"), 0, catalog).id).toBe(
      "shown",
    );
  });

  it("acting on a tip retires it", () => {
    const catalog = [
      testTip("a", { priority: 2 }),
      testTip("b", { priority: 1 }),
    ];
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    expect(first.id).toBe("a");
    const acted = actOnTip(first.state, "a", "1.0.0", START, catalog);
    expect(acted.records.a).toMatchObject({
      actedAt: START,
      retiredReason: "acted",
    });
    expect(showOn(acted, 1, catalog).id).toBe("b");
    expect(showOn(acted, 3, catalog).id).not.toBe("a");
  });

  it("rejects unknown tip ids", () => {
    expect(() =>
      dismissTip(createTipsState(START, null), "nope", null, START),
    ).toThrow(UnknownTipError);
    expect(() =>
      actOnTip(createTipsState(START, null), "nope", null, START),
    ).toThrow(UnknownTipError);
  });

  it("brings dismissed and retired tips back after a reset", () => {
    const catalog = [testTip("a")];
    const dismissed = dismissTip(
      showOn(createTipsState(START, "1.0.0"), 0, catalog).state,
      "a",
      "1.0.0",
      START,
      catalog,
    );
    const reset = resetTips(dismissed);
    expect(reset.records).toEqual({});
    expect(reset.current).toBeNull();
    expect(showOn(reset, 0, catalog).id).toBe("a");
  });
});

describe("what's new", () => {
  const whatsNew = catalogTip("whats-new");

  it("stays quiet on the version bb was first seen on", () => {
    expect(whatsNew.when(signals())).toBe(false);
  });

  it("shows once for each new version", () => {
    const catalog = [whatsNew];
    const upgraded = { appVersion: "1.1.0", firstSeenVersion: "1.0.0" };
    let state = createTipsState(START, "1.0.0");
    const first = showOn(state, 0, catalog, upgraded);
    expect(first.id).toBe("whats-new");
    state = first.state;
    expect(showOn(state, 1, catalog, upgraded).id).toBeNull();
    expect(
      showOn(state, 2, catalog, {
        appVersion: "1.2.0",
        firstSeenVersion: "1.0.0",
      }).id,
    ).toBe("whats-new");
  });

  it("names the version and opens the Updates section", () => {
    const view = renderTip(
      whatsNew,
      signals({ appVersion: "1.1.0", firstSeenVersion: "1.0.0" }),
    );
    expect(view.title).toBe("What's new in v1.1.0");
    expect(view.action).toEqual({
      kind: "route",
      label: "See what's new",
      path: "/settings/updates#whats-new",
    });
  });
});

describe("catalog predicates", () => {
  it("offers subthreads after a finished thread and retires them once a child thread exists", () => {
    const subthreads = catalogTip("subthreads");
    expect(subthreads.when(signals())).toBe(false);
    expect(subthreads.when(signals({ hasFinishedThread: true }))).toBe(true);
    expect(subthreads.used(signals({ hasChildThread: true }))).toBe(true);
    expect(subthreads.action?.kind).toBe("prompt");
  });

  it("offers Account Pooler to rate-limited or heavy Claude Code and Codex users until it is enabled", () => {
    const pool = catalogTip("account-pool");
    const base = {
      installedPlugins: { "account-pool": false },
      providersUsed: ["claude-code"],
    };
    expect(pool.held).toBe(false);
    expect(pool.when(signals(base))).toBe(false);
    expect(pool.when(signals({ ...base, rateLimited: true }))).toBe(true);
    expect(pool.when(signals({ ...base, threadCount: 50 }))).toBe(true);
    expect(
      pool.when(signals({ ...base, providersUsed: ["pi"], rateLimited: true })),
    ).toBe(false);
    expect(
      pool.when(signals({ ...base, installedPlugins: {}, rateLimited: true })),
    ).toBe(false);
    expect(
      pool.used(signals({ installedPlugins: { "account-pool": true } })),
    ).toBe(true);
  });

  it("offers the phone app only away from the phone and retires it once the mobile app is used", () => {
    const phone = catalogTip("phone");
    const finished = { hasFinishedThread: true };
    expect(phone.when(signals(finished))).toBe(true);
    expect(
      phone.when(
        signals({ ...finished, client: { surface: "mobile-app", os: "ios" } }),
      ),
    ).toBe(false);
    expect(phone.used(signals({ usedMobileApp: true }))).toBe(true);
  });

  it("never offers Browser Automation on Windows and retires it once enabled", () => {
    const browser = catalogTip("browser-automation");
    const finished = { hasFinishedThread: true };
    expect(browser.when(signals(finished))).toBe(true);
    expect(
      browser.when(signals({ ...finished, serverPlatform: "win32" })),
    ).toBe(false);
    expect(
      browser.when(
        signals({ ...finished, client: { surface: "web", os: "windows" } }),
      ),
    ).toBe(false);
    expect(
      browser.used(
        signals({ installedPlugins: { "browser-automation": true } }),
      ),
    ).toBe(true);
  });

  it("limits keyboard tips to keyboard clients and uses the client's shortcut", () => {
    const palette = catalogTip("command-palette");
    const settled = { daysSinceFirstSeen: 3 };
    expect(palette.when(signals(settled))).toBe(true);
    expect(
      palette.when(
        signals({
          ...settled,
          client: { surface: "mobile-web", os: "android" },
        }),
      ),
    ).toBe(false);
    expect(renderTip(palette, signals(settled)).body).toContain("⌘⇧P");
    expect(
      renderTip(
        palette,
        signals({ ...settled, client: { surface: "web", os: "windows" } }),
      ).body,
    ).toContain("Ctrl+Shift+P");
    expect(palette.action).toEqual({
      kind: "command",
      label: "Open",
      commandId: "palette.open",
    });
  });

  it("offers the desktop server menu only in the macOS desktop app", () => {
    const server = catalogTip("another-server");
    const used = { finishedThreadCount: 3 };
    expect(server.when(signals(used))).toBe(false);
    expect(
      server.when(
        signals({ ...used, client: { surface: "desktop", os: "macos" } }),
      ),
    ).toBe(true);
  });

  it("retires the automations tip once an automation has spawned a thread", () => {
    const automations = catalogTip("automations");
    const ready = {
      finishedThreadCount: 5,
      installedPlugins: { automations: true },
    };
    expect(automations.when(signals(ready))).toBe(true);
    expect(automations.when(signals({ ...ready, installedPlugins: {} }))).toBe(
      false,
    );
    expect(automations.used(signals({ hasAutomationThread: true }))).toBe(true);
  });

  it("keeps every tip's copy to one sentence with a valid action", () => {
    const ids = new Set<string>();
    for (const definition of TIP_CATALOG) {
      expect(ids.has(definition.id), definition.id).toBe(false);
      ids.add(definition.id);
      const view = renderTip(
        definition,
        signals({ appVersion: "1.1.0", firstSeenVersion: "1.0.0" }),
      );
      expect(tipViewSchema.safeParse(view).success, definition.id).toBe(true);
      expect(view.body.match(/[.!?](\s|$)/gu)?.length, definition.id).toBe(1);
      expect(view.body, definition.id).not.toMatch(/\{\w+\}/u);
      expect(view.title, definition.id).not.toMatch(/\{\w+\}/u);
    }
  });
});

describe("observations", () => {
  it("records the first seen version once and keeps sticky usage facts", () => {
    const initial = createTipsState(START, null);
    const observed = observeLiveSignals(
      initial,
      live({ appVersion: "2.0.0", finishedThreadCount: 1 }),
      { surface: "mobile-app", os: "ios" },
      START,
    );
    expect(observed.firstSeenVersion).toBe("2.0.0");
    expect(observed.observed).toMatchObject({
      finishedThread: true,
      mobileAppAt: START,
    });
    const later = observeLiveSignals(
      observed,
      live({ appVersion: "2.1.0", finishedThreadCount: 0 }),
      { surface: "web", os: "macos" },
      START + DAY_MS,
    );
    expect(later.firstSeenVersion).toBe("2.0.0");
    const derived = deriveSignals(
      later,
      live({ appVersion: "2.1.0" }),
      null,
      START + 3 * DAY_MS,
    );
    expect(derived).toMatchObject({
      hasFinishedThread: true,
      usedMobileApp: true,
      daysSinceFirstSeen: 3,
      firstSeenVersion: "2.0.0",
      appVersion: "2.1.0",
    });
  });

  it("refuses malformed stored state", () => {
    expect(parseTipsState({ version: 2 })).toBeNull();
    const state = createTipsState(START, "1.0.0");
    expect(parseTipsState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});

describe("listTips", () => {
  it("marks today's tip and hides retired tips unless all are requested", () => {
    const catalog = [
      testTip("a", { priority: 3 }),
      testTip("b", { priority: 2 }),
      testTip("c", { priority: 1, when: () => false }),
    ];
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    const dismissed = dismissTip(first.state, "b", "1.0.0", START, catalog);
    const eligible = listTips(dismissed, signals(), day(0), false, catalog);
    expect(eligible.map((entry) => [entry.id, entry.status])).toEqual([
      ["a", "current"],
    ]);
    const all = listTips(dismissed, signals(), day(0), true, catalog);
    expect(all.map((entry) => [entry.id, entry.status])).toEqual([
      ["a", "current"],
      ["b", "dismissed"],
      ["c", "not-applicable"],
    ]);
    expect(all[0]).toMatchObject({ shownDays: 1, dismissed: false });
    expect(all[1]).toMatchObject({ dismissed: true });
  });
});
