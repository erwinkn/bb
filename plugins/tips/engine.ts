import { z } from "zod";
import {
  TIP_CATALOG,
  renderTip,
  type TipDefinition,
  type TipSignals,
} from "./catalog.js";
import {
  TIPS_PER_SET,
  tipRetiredReasonSchema,
  type TipClient,
  type TipListEntry,
  type TipRetiredReason,
  type TipStatus,
} from "./contract.js";

const DAY_MS = 86_400_000;
const RECENT_RATE_LIMIT_MS = 14 * DAY_MS;

const tipRecordSchema = z
  .object({
    shownDays: z.number().int().nonnegative(),
    lastShownDay: z.string().nullable(),
    dismissedAt: z.number().nullable(),
    actedAt: z.number().nullable(),
    retiredAt: z.number().nullable(),
    retiredReason: tipRetiredReasonSchema.nullable(),
  })
  .strict();
export type TipRecord = z.infer<typeof tipRecordSchema>;

const tipsCurrentSetSchema = z
  .object({
    day: z.string(),
    projectId: z.string().nullable(),
    keys: z.array(z.string()),
    seen: z.array(z.string()),
  })
  .strict();
export type TipsCurrentSet = z.infer<typeof tipsCurrentSetSchema>;

export const tipsStateSchema = z
  .object({
    version: z.literal(2),
    firstSeenAt: z.number(),
    firstSeenVersion: z.string().nullable(),
    current: tipsCurrentSetSchema.nullable(),
    hiddenDay: z.string().nullable(),
    records: z.record(z.string(), tipRecordSchema),
    observed: z
      .object({
        finishedThread: z.boolean(),
        childThread: z.boolean(),
        automationThread: z.boolean(),
        rateLimitedAt: z.number().nullable(),
        queuedFollowUpAt: z.number().nullable(),
        mobileAppAt: z.number().nullable(),
      })
      .strict(),
  })
  .strict();
export type TipsState = z.infer<typeof tipsStateSchema>;

export interface LiveSignals {
  projectId: string | null;
  serverPlatform: string;
  appVersion: string | null;
  threadCount: number;
  finishedThreadCount: number;
  hasChildThread: boolean;
  hasAutomationThread: boolean;
  projectHasChildThread: boolean;
  projectHasAutomationThread: boolean;
  waitingThreadCount: number;
  providersUsed: readonly string[];
  availableProviderCount: number;
  installedPlugins: Readonly<Record<string, boolean>>;
}

export class UnknownTipError extends Error {
  constructor(id: string) {
    super(`Unknown tip: ${id}`);
    this.name = "UnknownTipError";
  }
}

const EMPTY_RECORD: TipRecord = {
  shownDays: 0,
  lastShownDay: null,
  dismissedAt: null,
  actedAt: null,
  retiredAt: null,
  retiredReason: null,
};

export function localDay(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function createTipsState(
  now: number,
  appVersion: string | null,
): TipsState {
  return {
    version: 2,
    firstSeenAt: now,
    firstSeenVersion: appVersion,
    current: null,
    hiddenDay: null,
    records: {},
    observed: {
      finishedThread: false,
      childThread: false,
      automationThread: false,
      rateLimitedAt: null,
      queuedFollowUpAt: null,
      mobileAppAt: null,
    },
  };
}

export function parseTipsState(value: unknown): TipsState | null {
  const parsed = tipsStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function observeLiveSignals(
  state: TipsState,
  live: LiveSignals,
  client: TipClient | null,
  now: number,
): TipsState {
  return {
    ...state,
    firstSeenVersion: state.firstSeenVersion ?? live.appVersion,
    observed: {
      ...state.observed,
      finishedThread:
        state.observed.finishedThread || live.finishedThreadCount > 0,
      childThread: state.observed.childThread || live.hasChildThread,
      automationThread:
        state.observed.automationThread || live.hasAutomationThread,
      mobileAppAt:
        state.observed.mobileAppAt ??
        (client?.surface === "mobile-app" ? now : null),
    },
  };
}

export function deriveSignals(
  state: TipsState,
  live: LiveSignals,
  client: TipClient | null,
  now: number,
): TipSignals {
  return {
    client,
    projectId: live.projectId,
    serverPlatform: live.serverPlatform,
    appVersion: live.appVersion,
    firstSeenVersion: state.firstSeenVersion,
    daysSinceFirstSeen: Math.max(
      0,
      Math.floor((now - state.firstSeenAt) / DAY_MS),
    ),
    threadCount: live.threadCount,
    availableProviderCount: live.availableProviderCount,
    providersUsed: live.providersUsed,
    installedPlugins: live.installedPlugins,
    hasFinishedThread:
      state.observed.finishedThread || live.finishedThreadCount > 0,
    finishedThreadCount: live.finishedThreadCount,
    hasChildThread: state.observed.childThread || live.hasChildThread,
    hasAutomationThread:
      state.observed.automationThread || live.hasAutomationThread,
    projectHasChildThread: live.projectHasChildThread,
    projectHasAutomationThread: live.projectHasAutomationThread,
    waitingThreadCount: live.waitingThreadCount,
    rateLimited: state.observed.rateLimitedAt !== null,
    recentlyRateLimited:
      state.observed.rateLimitedAt !== null &&
      now - state.observed.rateLimitedAt <= RECENT_RATE_LIMIT_MS,
    queuedFollowUp: state.observed.queuedFollowUpAt !== null,
    usedMobileApp: state.observed.mobileAppAt !== null,
  };
}

export function findTip(
  id: string,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipDefinition | null {
  return catalog.find((definition) => definition.id === id) ?? null;
}

export function recordKey(
  definition: TipDefinition,
  appVersion: string | null,
): string {
  return definition.perVersion
    ? `${definition.id}@${appVersion ?? "unknown"}`
    : definition.id;
}

function recordFor(
  state: TipsState,
  definition: TipDefinition,
  signals: TipSignals,
): TipRecord {
  return (
    state.records[recordKey(definition, signals.appVersion)] ?? EMPTY_RECORD
  );
}

function withRecord(
  state: TipsState,
  key: string,
  update: (record: TipRecord) => TipRecord,
): TipsState {
  return {
    ...state,
    records: {
      ...state.records,
      [key]: update(state.records[key] ?? EMPTY_RECORD),
    },
  };
}

export function evaluateTip(
  definition: TipDefinition,
  state: TipsState,
  signals: TipSignals,
): Exclude<TipStatus, "current"> {
  if (definition.held) return "held";
  const record = recordFor(state, definition, signals);
  if (record.dismissedAt !== null) return "dismissed";
  if (record.retiredAt !== null) return "retired";
  return definition.when(signals) ? "eligible" : "not-applicable";
}

function retire(
  state: TipsState,
  key: string,
  reason: TipRetiredReason,
  now: number,
): TipsState {
  return withRecord(state, key, (record) => ({
    ...record,
    retiredAt: now,
    retiredReason: reason,
  }));
}

export function retireTips(
  state: TipsState,
  signals: TipSignals,
  today: string,
  now: number,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipsState {
  let next = state;
  for (const definition of catalog) {
    if (definition.held) continue;
    const key = recordKey(definition, signals.appVersion);
    const record = next.records[key] ?? EMPTY_RECORD;
    if (record.dismissedAt !== null || record.retiredAt !== null) continue;
    if (definition.used(signals)) {
      next = retire(next, key, "used", now);
    } else if (
      record.shownDays >= definition.maxShowDays &&
      record.lastShownDay !== today
    ) {
      next = retire(next, key, "seen", now);
    }
  }
  return next;
}

interface Candidate {
  definition: TipDefinition;
  boost: number;
  priorShownDays: number;
  index: number;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.boost !== right.boost) return right.boost - left.boost;
  if (left.priorShownDays !== right.priorShownDays) {
    return left.priorShownDays - right.priorShownDays;
  }
  if (left.definition.priority !== right.definition.priority) {
    return right.definition.priority - left.definition.priority;
  }
  return left.index - right.index;
}

export function rankEligibleTips(
  state: TipsState,
  signals: TipSignals,
  today: string,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipDefinition[] {
  return catalog
    .flatMap((definition, index): Candidate[] => {
      if (evaluateTip(definition, state, signals) !== "eligible") return [];
      const record = recordFor(state, definition, signals);
      return [
        {
          definition,
          boost: definition.boost(signals),
          priorShownDays:
            record.lastShownDay === today
              ? record.shownDays - 1
              : record.shownDays,
          index,
        },
      ];
    })
    .sort(compareCandidates)
    .map((candidate) => candidate.definition);
}

export interface TipSelection {
  state: TipsState;
  tips: TipDefinition[];
}

function keyOf(definition: TipDefinition, signals: TipSignals): string {
  return recordKey(definition, signals.appVersion);
}

function staysInTodaysSet(
  definition: TipDefinition,
  state: TipsState,
  signals: TipSignals,
  today: string,
): boolean {
  const status = evaluateTip(definition, state, signals);
  if (status === "eligible") return true;
  const record = recordFor(state, definition, signals);
  return (
    status === "retired" &&
    record.retiredReason === "acted" &&
    record.lastShownDay === today
  );
}

function markShown(
  state: TipsState,
  definitions: readonly TipDefinition[],
  signals: TipSignals,
  today: string,
): TipsState {
  let next = state;
  for (const definition of definitions) {
    next = withRecord(next, keyOf(definition, signals), (record) =>
      record.lastShownDay === today
        ? record
        : {
            ...record,
            shownDays: record.shownDays + 1,
            lastShownDay: today,
          },
    );
  }
  return next;
}

function definitionsForKeys(
  keys: readonly string[],
  signals: TipSignals,
  catalog: readonly TipDefinition[],
): TipDefinition[] {
  return keys.flatMap((key) => {
    const definition = catalog.find(
      (candidate) => keyOf(candidate, signals) === key,
    );
    return definition === undefined ? [] : [definition];
  });
}

function todaysSet(
  state: TipsState,
  signals: TipSignals,
  today: string,
): TipsCurrentSet | null {
  const current = state.current;
  if (current === null) return null;
  if (current.day !== today || current.projectId !== signals.projectId) {
    return null;
  }
  return current;
}

function storeSet(
  state: TipsState,
  definitions: readonly TipDefinition[],
  seen: readonly string[],
  signals: TipSignals,
  today: string,
): TipsState {
  const keys = definitions.map((definition) => keyOf(definition, signals));
  return {
    ...markShown(state, definitions, signals, today),
    current: {
      day: today,
      projectId: signals.projectId,
      keys,
      seen: [...new Set([...seen, ...keys])],
    },
  };
}

export function selectTips(
  state: TipsState,
  signals: TipSignals,
  today: string,
  now: number,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipSelection {
  const next = retireTips(state, signals, today, now, catalog);
  if (next.hiddenDay === today) return { state: next, tips: [] };
  const existing = todaysSet(next, signals, today);
  const kept = definitionsForKeys(
    existing?.keys ?? [],
    signals,
    catalog,
  ).filter((definition) => staysInTodaysSet(definition, next, signals, today));
  const unchanged = existing !== null && kept.length === existing.keys.length;
  if (unchanged && kept.length >= TIPS_PER_SET) {
    return { state: next, tips: kept };
  }
  const keptKeys = new Set(
    kept.map((definition) => keyOf(definition, signals)),
  );
  const seen = new Set(existing?.seen ?? []);
  const ranked = rankEligibleTips(next, signals, today, catalog).filter(
    (definition) => !keptKeys.has(keyOf(definition, signals)),
  );
  const fresh = ranked.filter(
    (definition) => !seen.has(keyOf(definition, signals)),
  );
  const repeat = ranked.filter((definition) =>
    seen.has(keyOf(definition, signals)),
  );
  const added = [...fresh, ...repeat].slice(0, TIPS_PER_SET - kept.length);
  const tips = [...kept, ...added];
  if (unchanged && added.length === 0) return { state: next, tips };
  return {
    state: storeSet(next, tips, existing?.seen ?? [], signals, today),
    tips,
  };
}

export function moreTips(
  state: TipsState,
  signals: TipSignals,
  today: string,
  now: number,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipSelection {
  const selection = selectTips(state, signals, today, now, catalog);
  if (selection.tips.length === 0) return selection;
  const current = selection.state.current;
  const currentKeys = new Set(
    selection.tips.map((definition) => keyOf(definition, signals)),
  );
  const ranked = rankEligibleTips(selection.state, signals, today, catalog);
  const others = ranked.filter(
    (definition) => !currentKeys.has(keyOf(definition, signals)),
  );
  if (others.length === 0) return selection;
  const seen = new Set(current?.seen ?? []);
  const unseen = others.filter(
    (definition) => !seen.has(keyOf(definition, signals)),
  );
  const restart = unseen.length === 0;
  const pool = restart
    ? others
    : [
        ...unseen,
        ...others.filter((definition) => seen.has(keyOf(definition, signals))),
      ];
  const picks = pool.slice(0, TIPS_PER_SET);
  const filler = selection.tips.slice(0, TIPS_PER_SET - picks.length);
  const tips = [...picks, ...filler];
  return {
    state: storeSet(
      selection.state,
      tips,
      restart ? [...currentKeys] : (current?.seen ?? []),
      signals,
      today,
    ),
    tips,
  };
}

export function hideTips(
  state: TipsState,
  hidden: boolean,
  today: string,
): TipsState {
  return { ...state, hiddenDay: hidden ? today : null };
}

export function dismissTip(
  state: TipsState,
  id: string,
  appVersion: string | null,
  now: number,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipsState {
  const definition = findTip(id, catalog);
  if (definition === null) throw new UnknownTipError(id);
  return withRecord(state, recordKey(definition, appVersion), (record) => ({
    ...record,
    dismissedAt: record.dismissedAt ?? now,
  }));
}

export function actOnTip(
  state: TipsState,
  id: string,
  appVersion: string | null,
  now: number,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipsState {
  const definition = findTip(id, catalog);
  if (definition === null) throw new UnknownTipError(id);
  return withRecord(state, recordKey(definition, appVersion), (record) => ({
    ...record,
    actedAt: record.actedAt ?? now,
    retiredAt: record.retiredAt ?? now,
    retiredReason: record.retiredReason ?? "acted",
  }));
}

export function resetTips(state: TipsState): TipsState {
  return { ...state, current: null, hiddenDay: null, records: {} };
}

export function listTips(
  state: TipsState,
  signals: TipSignals,
  today: string,
  all: boolean,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipListEntry[] {
  const showing = new Set(
    state.current?.day === today && state.hiddenDay !== today
      ? state.current.keys
      : [],
  );
  return [...catalog]
    .sort((left, right) => right.priority - left.priority)
    .flatMap((definition) => {
      const key = recordKey(definition, signals.appVersion);
      const record = recordFor(state, definition, signals);
      const evaluated = evaluateTip(definition, state, signals);
      const status: TipStatus =
        evaluated === "eligible" && showing.has(key) ? "current" : evaluated;
      if (!all && status !== "current" && status !== "eligible") return [];
      return [
        {
          ...renderTip(definition, signals),
          status,
          shownDays: record.shownDays,
          dismissed: record.dismissedAt !== null,
          acted: record.actedAt !== null,
          retiredReason: record.retiredReason,
        },
      ];
    });
}
