import { describe, expect, it } from "vitest";
import {
  TIP_CATALOG,
  renderTip,
  type TipDefinition,
  type TipSignals,
} from "./catalog.js";
import { tipViewSchema } from "./contract.js";
import {
  UnknownTipError,
  actOnTip,
  createTipsState,
  deriveSignals,
  dismissTip,
  hideTips,
  listTips,
  localDay,
  moreTips,
  observeLiveSignals,
  parseTipsState,
  rankEligibleTips,
  resetTips,
  selectTips,
  type LiveSignals,
  type TipsState,
} from "./engine.js";
import { isWaitingOnUser } from "./signals.js";

const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 9, 5, 12);

function signals(overrides: Partial<TipSignals> = {}): TipSignals {
  return {
    client: { surface: "web", os: "macos" },
    projectId: null,
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
    projectHasChildThread: false,
    projectHasAutomationThread: false,
    waitingThreadCount: 0,
    rateLimited: false,
    recentlyRateLimited: false,
    queuedFollowUp: false,
    usedMobileApp: false,
    ...overrides,
  };
}

function live(overrides: Partial<LiveSignals> = {}): LiveSignals {
  return {
    projectId: null,
    serverPlatform: "darwin",
    appVersion: "1.0.0",
    threadCount: 0,
    finishedThreadCount: 0,
    hasChildThread: false,
    hasAutomationThread: false,
    projectHasChildThread: false,
    projectHasAutomationThread: false,
    waitingThreadCount: 0,
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
    action: { kind: "prompt", label: "Try it", prompt: `Prompt ${id}` },
    priority: 10,
    held: false,
    perVersion: false,
    maxShowDays: 2,
    when: () => true,
    used: () => false,
    boost: () => 0,
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
): { state: TipsState; ids: string[] } {
  const selection = selectTips(
    state,
    signals(overrides),
    day(offset),
    START + offset * DAY_MS,
    catalog,
  );
  return {
    state: selection.state,
    ids: selection.tips.map((definition) => definition.id),
  };
}

function moreOn(
  state: TipsState,
  offset: number,
  catalog: readonly TipDefinition[],
  overrides: Partial<TipSignals> = {},
): { state: TipsState; ids: string[] } {
  const selection = moreTips(
    state,
    signals(overrides),
    day(offset),
    START + offset * DAY_MS,
    catalog,
  );
  return {
    state: selection.state,
    ids: selection.tips.map((definition) => definition.id),
  };
}

function numbered(count: number): TipDefinition[] {
  return Array.from({ length: count }, (_, index) =>
    testTip(`t${index + 1}`, { priority: count - index, maxShowDays: 9 }),
  );
}

describe("selectTips", () => {
  it("shows the three highest-priority eligible tips and keeps them for the day", () => {
    const catalog = numbered(5);
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    expect(first.ids).toEqual(["t1", "t2", "t3"]);
    const again = showOn(first.state, 0, catalog);
    expect(again.ids).toEqual(["t1", "t2", "t3"]);
    expect(again.state.records.t1?.shownDays).toBe(1);
    expect(again.state.records.t4).toBeUndefined();
  });

  it("shows fewer tiles when fewer tips are eligible", () => {
    const catalog = [testTip("a"), testTip("b", { when: () => false })];
    expect(showOn(createTipsState(START, "1.0.0"), 0, catalog).ids).toEqual([
      "a",
    ]);
  });

  it("puts contextual tips ahead of priority order", () => {
    const catalog = [
      testTip("high", { priority: 9 }),
      testTip("medium", { priority: 5 }),
      testTip("low", { priority: 3 }),
      testTip("waiting", {
        priority: 1,
        boost: (current) => (current.waitingThreadCount > 0 ? 100 : 0),
      }),
    ];
    const quiet = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    expect(quiet.ids).toEqual(["high", "medium", "low"]);
    const busy = showOn(createTipsState(START, "1.0.0"), 0, catalog, {
      waitingThreadCount: 3,
    });
    expect(busy.ids).toEqual(["waiting", "high", "medium"]);
  });

  it("rotates to unseen tips on later days before repeating them", () => {
    const catalog = numbered(5);
    let state = createTipsState(START, "1.0.0");
    const days: string[][] = [];
    for (let offset = 0; offset < 3; offset += 1) {
      const result = showOn(state, offset, catalog);
      state = result.state;
      days.push(result.ids);
    }
    expect(days).toEqual([
      ["t1", "t2", "t3"],
      ["t4", "t5", "t1"],
      ["t2", "t3", "t4"],
    ]);
  });

  it("retires a tip after its maximum number of shown days", () => {
    const catalog = [testTip("only", { maxShowDays: 2 })];
    let state = createTipsState(START, "1.0.0");
    state = showOn(state, 0, catalog).state;
    state = showOn(state, 1, catalog).state;
    const third = showOn(state, 2, catalog);
    expect(third.ids).toEqual([]);
    expect(third.state.records.only).toMatchObject({
      shownDays: 2,
      retiredReason: "seen",
    });
  });

  it("never shows a dismissed tip again and fills its tile", () => {
    const catalog = numbered(4);
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    const dismissed = dismissTip(first.state, "t2", "1.0.0", START, catalog);
    expect(showOn(dismissed, 0, catalog).ids).toEqual(["t1", "t3", "t4"]);
    for (let offset = 1; offset < 4; offset += 1) {
      expect(showOn(dismissed, offset, catalog).ids).not.toContain("t2");
    }
  });

  it("keeps an acted-on tip in today's set and retires it after", () => {
    const catalog = numbered(4);
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    const acted = actOnTip(first.state, "t1", "1.0.0", START, catalog);
    expect(acted.records.t1).toMatchObject({
      actedAt: START,
      retiredReason: "acted",
    });
    expect(showOn(acted, 0, catalog).ids).toEqual(["t1", "t2", "t3"]);
    expect(showOn(acted, 1, catalog).ids).not.toContain("t1");
  });

  it("retires a tip for good once its feature is used, even if the signal later reverts", () => {
    const catalog = [
      testTip("feature", { used: (current) => current.hasChildThread }),
    ];
    const used = showOn(createTipsState(START, "1.0.0"), 0, catalog, {
      hasChildThread: true,
    });
    expect(used.ids).toEqual([]);
    expect(used.state.records.feature?.retiredReason).toBe("used");
    expect(
      showOn(used.state, 1, catalog, { hasChildThread: false }).ids,
    ).toEqual([]);
  });

  it("skips held and ineligible tips", () => {
    const catalog = [
      testTip("held", { priority: 9, held: true }),
      testTip("ineligible", { priority: 8, when: () => false }),
      testTip("shown", { priority: 1 }),
    ];
    expect(showOn(createTipsState(START, "1.0.0"), 0, catalog).ids).toEqual([
      "shown",
    ]);
  });

  it("picks a new set when the selected project changes", () => {
    const catalog = [
      testTip("here", {
        priority: 9,
        when: (current) => current.projectId !== "proj_busy",
      }),
      ...numbered(3),
    ];
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog, {
      projectId: "proj_new",
    });
    expect(first.ids).toEqual(["here", "t1", "t2"]);
    const busy = showOn(first.state, 0, catalog, { projectId: "proj_busy" });
    expect(busy.ids).toEqual(["t1", "t2", "t3"]);
    expect(busy.state.records.t1?.shownDays).toBe(1);
  });

  it("hides tips for the rest of the day and shows them again on undo or tomorrow", () => {
    const catalog = numbered(3);
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    const hidden = hideTips(first.state, true, day(0));
    expect(showOn(hidden, 0, catalog).ids).toEqual([]);
    expect(showOn(hideTips(hidden, false, day(0)), 0, catalog).ids).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
    expect(showOn(hidden, 1, catalog).ids).toHaveLength(3);
  });

  it("rejects unknown tip ids", () => {
    expect(() =>
      dismissTip(createTipsState(START, null), "nope", null, START),
    ).toThrow(UnknownTipError);
    expect(() =>
      actOnTip(createTipsState(START, null), "nope", null, START),
    ).toThrow(UnknownTipError);
  });

  it("brings dismissed, retired, and hidden tips back after a reset", () => {
    const catalog = [testTip("a")];
    const dismissed = hideTips(
      dismissTip(
        showOn(createTipsState(START, "1.0.0"), 0, catalog).state,
        "a",
        "1.0.0",
        START,
        catalog,
      ),
      true,
      day(0),
    );
    const reset = resetTips(dismissed);
    expect(reset.records).toEqual({});
    expect(reset.current).toBeNull();
    expect(reset.hiddenDay).toBeNull();
    expect(showOn(reset, 0, catalog).ids).toEqual(["a"]);
  });
});

describe("moreTips", () => {
  it("rotates to the next three tips, then wraps around", () => {
    const catalog = numbered(7);
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    expect(first.ids).toEqual(["t1", "t2", "t3"]);
    const second = moreOn(first.state, 0, catalog);
    expect(second.ids).toEqual(["t4", "t5", "t6"]);
    expect(showOn(second.state, 0, catalog).ids).toEqual(["t4", "t5", "t6"]);
    const third = moreOn(second.state, 0, catalog);
    expect(third.ids).toEqual(["t7", "t1", "t2"]);
    const fourth = moreOn(third.state, 0, catalog);
    expect(fourth.ids).toEqual(["t3", "t4", "t5"]);
    expect(fourth.state.records.t4?.shownDays).toBe(1);
  });

  it("keeps the set when no other tip is eligible and tops up a short pool", () => {
    const three = numbered(3);
    const first = showOn(createTipsState(START, "1.0.0"), 0, three);
    expect(moreOn(first.state, 0, three).ids).toEqual(["t1", "t2", "t3"]);
    const four = numbered(4);
    const start = showOn(createTipsState(START, "1.0.0"), 0, four);
    expect(moreOn(start.state, 0, four).ids).toEqual(["t4", "t1", "t2"]);
  });

  it("shows nothing while tips are hidden", () => {
    const catalog = numbered(4);
    const hidden = hideTips(createTipsState(START, "1.0.0"), true, day(0));
    expect(moreOn(hidden, 0, catalog).ids).toEqual([]);
  });
});

describe("contextual ranking", () => {
  it("leads with threads waiting on you, then Account Pooler after a recent rate limit", () => {
    const context = {
      hasFinishedThread: true,
      finishedThreadCount: 5,
      threadCount: 20,
      providersUsed: ["claude-code"],
      installedPlugins: { "account-pool": false },
      rateLimited: true,
    };
    const ranked = (overrides: Partial<TipSignals>) =>
      rankEligibleTips(
        createTipsState(START, "1.0.0"),
        signals({ ...context, ...overrides }),
        day(0),
      ).map((definition) => definition.id);
    expect(ranked({}).slice(0, 2)).toEqual(["account-pool", "subthreads"]);
    expect(ranked({ recentlyRateLimited: true })[0]).toBe("account-pool");
    expect(
      ranked({ recentlyRateLimited: true, waitingThreadCount: 4 }).slice(0, 2),
    ).toEqual(["open-threads-that-need-me", "account-pool"]);
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
    expect(first.ids).toEqual(["whats-new"]);
    state = first.state;
    expect(showOn(state, 1, catalog, upgraded).ids).toEqual([]);
    expect(
      showOn(state, 2, catalog, {
        appVersion: "1.2.0",
        firstSeenVersion: "1.0.0",
      }).ids,
    ).toEqual(["whats-new"]);
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
  it("offers subthreads only where they are not in use yet", () => {
    const subthreads = catalogTip("subthreads");
    const finished = { hasFinishedThread: true };
    expect(subthreads.when(signals())).toBe(false);
    expect(subthreads.when(signals(finished))).toBe(true);
    expect(
      subthreads.when(signals({ ...finished, hasChildThread: true })),
    ).toBe(false);
    expect(
      subthreads.when(
        signals({ ...finished, hasChildThread: true, projectId: "proj_new" }),
      ),
    ).toBe(true);
    expect(
      subthreads.when(
        signals({
          ...finished,
          projectId: "proj_busy",
          projectHasChildThread: true,
        }),
      ),
    ).toBe(false);
    expect(subthreads.action.kind).toBe("prompt");
  });

  it("offers the waiting-threads tip only when two or more threads need you", () => {
    const waiting = catalogTip("open-threads-that-need-me");
    expect(waiting.when(signals({ waitingThreadCount: 1 }))).toBe(false);
    expect(waiting.when(signals({ waitingThreadCount: 2 }))).toBe(true);
    expect(
      waiting.when(
        signals({
          waitingThreadCount: 5,
          client: { surface: "mobile-app", os: "ios" },
        }),
      ),
    ).toBe(false);
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
      label: "Open palette",
      commandId: "palette.open",
    });
  });

  it("offers automations only where none has run yet", () => {
    const automations = catalogTip("automations");
    const ready = {
      finishedThreadCount: 5,
      installedPlugins: { automations: true },
    };
    expect(automations.when(signals(ready))).toBe(true);
    expect(automations.when(signals({ ...ready, installedPlugins: {} }))).toBe(
      false,
    );
    expect(
      automations.when(signals({ ...ready, hasAutomationThread: true })),
    ).toBe(false);
    expect(
      automations.when(
        signals({
          ...ready,
          projectId: "proj_1",
          projectHasAutomationThread: true,
        }),
      ),
    ).toBe(false);
    expect(
      automations.when(
        signals({ ...ready, projectId: "proj_2", hasAutomationThread: true }),
      ),
    ).toBe(true);
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
  it("marks today's three tips and hides retired tips unless all are requested", () => {
    const catalog = [
      ...numbered(4),
      testTip("off", { priority: 0, when: () => false }),
    ];
    const first = showOn(createTipsState(START, "1.0.0"), 0, catalog);
    const dismissed = dismissTip(first.state, "t4", "1.0.0", START, catalog);
    const eligible = listTips(dismissed, signals(), day(0), false, catalog);
    expect(eligible.map((entry) => [entry.id, entry.status])).toEqual([
      ["t1", "current"],
      ["t2", "current"],
      ["t3", "current"],
    ]);
    const all = listTips(dismissed, signals(), day(0), true, catalog);
    expect(all.map((entry) => [entry.id, entry.status])).toEqual([
      ["t1", "current"],
      ["t2", "current"],
      ["t3", "current"],
      ["t4", "dismissed"],
      ["off", "not-applicable"],
    ]);
    expect(all[0]).toMatchObject({ shownDays: 1, dismissed: false });
    expect(all[3]).toMatchObject({ dismissed: true });
    const hidden = listTips(
      hideTips(dismissed, true, day(0)),
      signals(),
      day(0),
      false,
      catalog,
    );
    expect(hidden.map((entry) => entry.status)).toEqual([
      "eligible",
      "eligible",
      "eligible",
    ]);
  });
});

describe("isWaitingOnUser", () => {
  const row = {
    status: "idle",
    hasPendingInteraction: false,
    lastReadAt: 10,
    latestAttentionAt: 5,
  };

  it("counts unread results, errors, and open questions but not running or read threads", () => {
    expect(isWaitingOnUser(row)).toBe(false);
    expect(isWaitingOnUser({ ...row, latestAttentionAt: 20 })).toBe(true);
    expect(isWaitingOnUser({ ...row, lastReadAt: null })).toBe(true);
    expect(isWaitingOnUser({ ...row, status: "error" })).toBe(true);
    expect(
      isWaitingOnUser({ ...row, status: "active", latestAttentionAt: 20 }),
    ).toBe(false);
    expect(
      isWaitingOnUser({
        ...row,
        status: "active",
        hasPendingInteraction: true,
      }),
    ).toBe(true);
  });
});
