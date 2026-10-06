import { z } from "zod";
import { TIP_CATALOG, type TipDefinition, type TipSignals } from "./catalog.js";
import {
  tipRetiredReasonSchema,
  type TipClient,
  type TipListEntry,
  type TipRetiredReason,
  type TipStatus,
  type TipView,
} from "./contract.js";

const DAY_MS = 86_400_000;

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

export const tipsStateSchema = z
  .object({
    version: z.literal(1),
    firstSeenAt: z.number(),
    firstSeenVersion: z.string().nullable(),
    current: z.object({ key: z.string(), day: z.string() }).strict().nullable(),
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
  serverPlatform: string;
  appVersion: string | null;
  threadCount: number;
  finishedThreadCount: number;
  hasChildThread: boolean;
  hasAutomationThread: boolean;
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
    version: 1,
    firstSeenAt: now,
    firstSeenVersion: appVersion,
    current: null,
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
    rateLimited: state.observed.rateLimitedAt !== null,
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

function compareCandidates(
  left: { definition: TipDefinition; record: TipRecord; index: number },
  right: { definition: TipDefinition; record: TipRecord; index: number },
): number {
  if (left.record.shownDays !== right.record.shownDays) {
    return left.record.shownDays - right.record.shownDays;
  }
  const leftDay = left.record.lastShownDay ?? "";
  const rightDay = right.record.lastShownDay ?? "";
  if (leftDay !== rightDay) return leftDay < rightDay ? -1 : 1;
  if (left.definition.priority !== right.definition.priority) {
    return right.definition.priority - left.definition.priority;
  }
  return left.index - right.index;
}

export interface TipSelection {
  state: TipsState;
  tip: TipDefinition | null;
}

export function selectTip(
  state: TipsState,
  signals: TipSignals,
  today: string,
  now: number,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipSelection {
  const next = retireTips(state, signals, today, now, catalog);
  if (next.current !== null && next.current.day === today) {
    const currentKey = next.current.key;
    const current = catalog.find(
      (definition) => recordKey(definition, signals.appVersion) === currentKey,
    );
    return {
      state: next,
      tip:
        current !== undefined &&
        evaluateTip(current, next, signals) === "eligible"
          ? current
          : null,
    };
  }
  const [chosen] = catalog
    .map((definition, index) => ({
      definition,
      record: recordFor(next, definition, signals),
      index,
    }))
    .filter(
      ({ definition }) => evaluateTip(definition, next, signals) === "eligible",
    )
    .sort(compareCandidates);
  if (chosen === undefined) return { state: next, tip: null };
  const key = recordKey(chosen.definition, signals.appVersion);
  return {
    state: {
      ...withRecord(next, key, (record) => ({
        ...record,
        shownDays: record.shownDays + 1,
        lastShownDay: today,
      })),
      current: { key, day: today },
    },
    tip: chosen.definition,
  };
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
  return { ...state, current: null, records: {} };
}

function keyLabel(
  client: TipClient | null,
  mac: string,
  other: string,
): string {
  if (client === null) return `${mac} (${other})`;
  return client.os === "macos" ? mac : other;
}

function fillTemplate(text: string, signals: TipSignals): string {
  return text
    .replaceAll("{version}", signals.appVersion ?? "")
    .replaceAll(
      "{paletteKeys}",
      keyLabel(signals.client, "⌘⇧P", "Ctrl+Shift+P"),
    )
    .replaceAll("{searchKeys}", keyLabel(signals.client, "⌘K", "Ctrl+K"));
}

export function renderTip(
  definition: TipDefinition,
  signals: TipSignals,
): TipView {
  return {
    id: definition.id,
    title: fillTemplate(definition.title, signals),
    body: fillTemplate(definition.body, signals),
    action: definition.action,
  };
}

export function listTips(
  state: TipsState,
  signals: TipSignals,
  today: string,
  all: boolean,
  catalog: readonly TipDefinition[] = TIP_CATALOG,
): TipListEntry[] {
  return [...catalog]
    .sort((left, right) => right.priority - left.priority)
    .flatMap((definition) => {
      const key = recordKey(definition, signals.appVersion);
      const record = recordFor(state, definition, signals);
      const evaluated = evaluateTip(definition, state, signals);
      const status: TipStatus =
        evaluated === "eligible" &&
        state.current?.key === key &&
        state.current.day === today
          ? "current"
          : evaluated;
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
