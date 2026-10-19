import { createHash } from "node:crypto";
import type { TimelineRow } from "@bb/server-contract";
import {
  isExternalUserBoundaryForTurn,
  type ExternalUserBoundaryMessage,
  type ExternalUserBoundaryTurnSpan,
} from "@bb/thread-view";
import {
  getDatabaseDataVersion,
  getFirstParentedTimelineBoundarySequence,
  getThreadEventRewriteGeneration,
  getTimelineGroupingContextChangesInRange,
  getTimelineOrderingContextQuerySql,
  listTimelineOrderingContext,
  TIMELINE_ORDERING_CONTEXT_EVENT_TYPES,
  type DbConnection,
} from "@bb/db";
import { z } from "zod";
import {
  readPersistedCheckpoint,
  writePersistedCheckpoint,
  type PersistedCheckpointChain,
} from "./persisted-checkpoint.js";

interface TimelineGroupingContext {
  orderingBoundarySequence: number | null;
  acceptedTurnIds: ReadonlyMap<string, string>;
}

interface TimelineGroupingContextArgs {
  maxSeq: number;
  sequenceStart: number;
  threadId: string;
}

interface TimelineOrderingContext {
  acceptedTurnIds: ReadonlyMap<string, string>;
  boundarySequence: number | null;
  boundaryScanThroughSequence: number;
}

interface TimelineGroupingContextEntry {
  orderingContext: TimelineOrderingContext;
  context: TimelineGroupingContext;
  dataVersion: number;
  generation: number;
  maxSeq: number;
}

const GROUPING_CONTEXT_KEY_LIMIT = 128;
const GROUPING_CONTEXT_ENTRIES_PER_KEY = 4;
const GROUPING_CONTEXT_REUSE_SEQUENCE_SPAN = 1024;

type TimelineOrderingContextRow = ReturnType<
  typeof listTimelineOrderingContext
>[number];

interface TimelineOrderingRowsEntry {
  chain: PersistedCheckpointChain | null;
  dataVersion: number;
  generation: number;
  maxSeq: number;
  persistedMaxSeq: number;
  rows: TimelineOrderingContextRow[];
}

const ORDERING_ROWS_KEY_LIMIT = 32;
const PERSISTED_ORDERING_ROWS_KIND = "timeline-ordering-rows";
const PERSISTED_ORDERING_ROWS_MAX_CHARS = 16_000_000;

const persistedOrderingRowsPartSchema = z.object({
  maxSeq: z.number().int(),
  previousMaxSeq: z.number().int(),
  query: z.string(),
  rows: z.array(z.unknown()),
  sequenceStart: z.number().int(),
});

type PersistedOrderingRowsPart = z.infer<
  typeof persistedOrderingRowsPartSchema
>;

const orderingEventTypes: readonly string[] =
  TIMELINE_ORDERING_CONTEXT_EVENT_TYPES;

function isOrderingEventType(
  value: unknown,
): value is TimelineOrderingContextRow["type"] {
  return typeof value === "string" && orderingEventTypes.includes(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function decodeOrderingRow(value: unknown): TimelineOrderingContextRow | null {
  if (!Array.isArray(value) || value.length !== 8) return null;
  const [
    sequence,
    type,
    turnId,
    parentToolCallId,
    requestId,
    clientRequestId,
    expectedTurnId,
    hasVisibleUserInput,
  ] = value;
  if (
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    !isOrderingEventType(type) ||
    !isNullableString(turnId) ||
    !isNullableString(parentToolCallId) ||
    !isNullableString(requestId) ||
    !isNullableString(clientRequestId) ||
    !isNullableString(expectedTurnId) ||
    typeof hasVisibleUserInput !== "number"
  )
    return null;
  return {
    clientRequestId,
    expectedTurnId,
    hasVisibleUserInput,
    parentToolCallId,
    requestId,
    sequence,
    turnId,
    type,
  };
}

function orderingQueryFingerprint(db: DbConnection): string {
  return createHash("sha256")
    .update(getTimelineOrderingContextQuerySql(db))
    .digest("base64url");
}

function toPersistedOrderingRowsPart(
  db: DbConnection,
  args: TimelineGroupingContextArgs,
  previousMaxSeq: number,
  rows: readonly TimelineOrderingContextRow[],
): PersistedOrderingRowsPart {
  return {
    maxSeq: args.maxSeq,
    previousMaxSeq,
    query: orderingQueryFingerprint(db),
    rows: rows.map((row) => [
      row.sequence,
      row.type,
      row.turnId,
      row.parentToolCallId,
      row.requestId,
      row.clientRequestId,
      row.expectedTurnId,
      row.hasVisibleUserInput,
    ]),
    sequenceStart: args.sequenceStart,
  };
}

function readPersistedOrderingRows(
  db: DbConnection,
  args: TimelineGroupingContextArgs,
  current: { dataVersion: number; generation: number },
): TimelineOrderingRowsEntry | undefined {
  const persisted = readPersistedCheckpoint(
    db,
    {
      kind: `${PERSISTED_ORDERING_ROWS_KIND}:${args.sequenceStart}`,
      threadId: args.threadId,
    },
    persistedOrderingRowsPartSchema,
  );
  if (persisted === null) return undefined;
  const query = orderingQueryFingerprint(db);
  const rows: TimelineOrderingContextRow[] = [];
  let maxSeq = args.sequenceStart - 1;
  for (const part of persisted.parts) {
    if (
      part.query !== query ||
      part.sequenceStart !== args.sequenceStart ||
      part.previousMaxSeq !== maxSeq ||
      part.maxSeq <= maxSeq
    )
      return undefined;
    let previousSequence = maxSeq;
    for (const value of part.rows) {
      const row = decodeOrderingRow(value);
      if (
        row === null ||
        row.sequence <= previousSequence ||
        row.sequence > part.maxSeq
      )
        return undefined;
      rows.push(row);
      previousSequence = row.sequence;
    }
    maxSeq = part.maxSeq;
  }
  return {
    chain: persisted.chain,
    ...current,
    maxSeq,
    persistedMaxSeq: maxSeq,
    rows,
  };
}

const orderingContexts = new WeakMap<
  DbConnection,
  Map<string, TimelineGroupingContextEntry[]>
>();
const orderingRows = new WeakMap<
  DbConnection,
  Map<string, TimelineOrderingRowsEntry>
>();

export function clearTimelineOrderingContextCache(db: DbConnection): void {
  orderingContexts.delete(db);
  orderingRows.delete(db);
}

function listTimelineOrderingContextIncrementally(
  db: DbConnection,
  args: TimelineGroupingContextArgs,
): TimelineOrderingContextRow[] {
  let cache = orderingRows.get(db);
  if (cache === undefined) {
    cache = new Map();
    orderingRows.set(db, cache);
  }
  const key = JSON.stringify([args.threadId, args.sequenceStart]);
  const generation = getThreadEventRewriteGeneration(args.threadId);
  const dataVersion = getDatabaseDataVersion(db);
  const cached =
    cache.get(key) ??
    readPersistedOrderingRows(db, args, { dataVersion, generation });
  cache.delete(key);
  const usable =
    cached !== undefined &&
    cached.generation === generation &&
    cached.dataVersion === dataVersion;
  if (usable && args.maxSeq <= cached.maxSeq) {
    cache.set(key, cached);
    return cached.rows.filter((row) => row.sequence <= args.maxSeq);
  }
  const appended = usable
    ? listTimelineOrderingContext(db, {
        ...args,
        sequenceStart: cached.maxSeq + 1,
      })
    : [];
  const rows = usable
    ? [...cached.rows, ...appended]
    : listTimelineOrderingContext(db, args);
  const persistedKey = {
    kind: `${PERSISTED_ORDERING_ROWS_KIND}:${args.sequenceStart}`,
    threadId: args.threadId,
  };
  const keepsChain = usable && (appended.length === 0 || cached.chain === null);
  const chain = keepsChain
    ? cached.chain
    : writePersistedCheckpoint(db, persistedKey, {
        chain: usable ? cached.chain : null,
        full: () =>
          toPersistedOrderingRowsPart(db, args, args.sequenceStart - 1, rows),
        maxChars: PERSISTED_ORDERING_ROWS_MAX_CHARS,
        part: usable
          ? () =>
              toPersistedOrderingRowsPart(
                db,
                args,
                cached.persistedMaxSeq,
                appended,
              )
          : null,
      });
  cache.set(key, {
    chain,
    dataVersion,
    generation,
    maxSeq: args.maxSeq,
    persistedMaxSeq: keepsChain ? cached.persistedMaxSeq : args.maxSeq,
    rows,
  });
  if (cache.size > ORDERING_ROWS_KEY_LIMIT) {
    cache.delete(cache.keys().next().value!);
  }
  return rows;
}

function nearestEntry(
  entries: readonly TimelineGroupingContextEntry[],
  maxSeq: number,
  side: "above" | "below",
): TimelineGroupingContextEntry | undefined {
  let nearest: TimelineGroupingContextEntry | undefined;
  for (const entry of entries) {
    const onSide =
      side === "above" ? entry.maxSeq > maxSeq : entry.maxSeq < maxSeq;
    if (
      onSide &&
      Math.abs(entry.maxSeq - maxSeq) <= GROUPING_CONTEXT_REUSE_SEQUENCE_SPAN &&
      (nearest === undefined ||
        Math.abs(entry.maxSeq - maxSeq) < Math.abs(nearest.maxSeq - maxSeq))
    ) {
      nearest = entry;
    }
  }
  return nearest;
}

function findReusableEntry(
  db: DbConnection,
  args: TimelineGroupingContextArgs,
  entries: readonly TimelineGroupingContextEntry[],
):
  | { entry: TimelineGroupingContextEntry; parentedChanged: boolean }
  | undefined {
  const exact = entries.find((entry) => entry.maxSeq === args.maxSeq);
  if (exact !== undefined) return { entry: exact, parentedChanged: false };
  for (const side of ["below", "above"] as const) {
    const entry = nearestEntry(entries, args.maxSeq, side);
    if (entry === undefined) continue;
    const changes = getTimelineGroupingContextChangesInRange(db, {
      afterSequence: Math.min(entry.maxSeq, args.maxSeq),
      threadId: args.threadId,
      throughSequence: Math.max(entry.maxSeq, args.maxSeq),
    });
    if (changes.ordering) continue;
    if (!changes.parented && side === "below") entry.maxSeq = args.maxSeq;
    return { entry, parentedChanged: changes.parented };
  }
  return undefined;
}

export function getTimelineGroupingContext(
  db: DbConnection,
  args: TimelineGroupingContextArgs,
): TimelineGroupingContext {
  let cache = orderingContexts.get(db);
  if (cache === undefined) {
    cache = new Map();
    orderingContexts.set(db, cache);
  }
  const key = JSON.stringify([args.threadId, args.sequenceStart]);
  const generation = getThreadEventRewriteGeneration(args.threadId);
  const dataVersion = getDatabaseDataVersion(db);
  const entries = (cache.get(key) ?? []).filter(
    (entry) =>
      entry.generation === generation && entry.dataVersion === dataVersion,
  );
  cache.delete(key);
  const reusable = findReusableEntry(db, args, entries);
  if (reusable !== undefined && !reusable.parentedChanged) {
    cache.set(key, [
      reusable.entry,
      ...entries.filter((entry) => entry !== reusable.entry),
    ]);
    return reusable.entry.context;
  }
  const orderingContext =
    reusable?.entry.orderingContext ?? computeTimelineOrderingContext(db, args);
  const parentedBoundary = getFirstParentedTimelineBoundarySequence(db, args);
  const context: TimelineGroupingContext = {
    acceptedTurnIds: orderingContext.acceptedTurnIds,
    orderingBoundarySequence:
      parentedBoundary !== null &&
      parentedBoundary <= orderingContext.boundaryScanThroughSequence
        ? parentedBoundary
        : (orderingContext.boundarySequence ?? parentedBoundary),
  };
  cache.set(key, [
    { context, orderingContext, dataVersion, generation, maxSeq: args.maxSeq },
    ...entries.slice(0, GROUPING_CONTEXT_ENTRIES_PER_KEY - 1),
  ]);
  if (cache.size > GROUPING_CONTEXT_KEY_LIMIT) {
    cache.delete(cache.keys().next().value!);
  }
  return context;
}

function computeTimelineOrderingContext(
  db: DbConnection,
  args: TimelineGroupingContextArgs,
): TimelineOrderingContext {
  const context = listTimelineOrderingContextIncrementally(db, args);
  const spans = new Map<string, ExternalUserBoundaryTurnSpan>();
  const accepted = new Map<string, { sequence: number; turnId: string }>();
  for (const row of context) {
    if (row.turnId === null) continue;
    if (row.type === "turn/input/accepted" && row.clientRequestId !== null) {
      accepted.set(row.clientRequestId, {
        sequence: row.sequence,
        turnId: row.turnId,
      });
    }
    if (
      row.type === "turn/started" &&
      row.parentToolCallId === null &&
      !spans.has(row.turnId)
    ) {
      spans.set(row.turnId, {
        completionSequence: null,
        sequenceStart: row.sequence,
        turnId: row.turnId,
      });
    }
    const span = spans.get(row.turnId);
    if (
      span !== undefined &&
      row.type === "turn/completed" &&
      span.completionSequence === null
    ) {
      span.completionSequence = row.sequence;
    }
  }
  const requests = context.filter(
    (row) => row.type === "client/turn/requested" && row.requestId !== null,
  );
  for (const row of requests) {
    const acceptance = accepted.get(row.requestId!);
    const span =
      acceptance === undefined ? undefined : spans.get(acceptance.turnId);
    if (span !== undefined) {
      span.sequenceStart = Math.min(span.sequenceStart, row.sequence);
    }
  }
  let boundary: number | null = null;
  let boundaryScanThroughSequence = -Infinity;
  const orderedSpans = [...spans.values()].sort(
    (left, right) => left.sequenceStart - right.sequenceStart,
  );
  let nextSpan = 0;
  let longest: ExternalUserBoundaryTurnSpan | null = null;
  let secondLongest: ExternalUserBoundaryTurnSpan | null = null;
  const spanEnd = (span: ExternalUserBoundaryTurnSpan | null): number =>
    span === null ? -Infinity : (span.completionSequence ?? Infinity);
  for (const row of requests) {
    if (row.hasVisibleUserInput !== 1) continue;
    const acceptance = accepted.get(row.requestId!);
    const steered =
      acceptance !== undefined &&
      row.expectedTurnId !== null &&
      acceptance.turnId === row.expectedTurnId;
    const message: ExternalUserBoundaryMessage = {
      sequence: steered ? acceptance.sequence : row.sequence,
      turnId: acceptance?.turnId ?? row.expectedTurnId,
    };
    boundaryScanThroughSequence = Math.max(
      boundaryScanThroughSequence,
      message.sequence,
    );
    while (
      nextSpan < orderedSpans.length &&
      orderedSpans[nextSpan]!.sequenceStart < message.sequence
    ) {
      const span = orderedSpans[nextSpan]!;
      if (spanEnd(span) > spanEnd(longest)) {
        secondLongest = longest;
        longest = span;
      } else if (spanEnd(span) > spanEnd(secondLongest)) {
        secondLongest = span;
      }
      nextSpan += 1;
    }
    const candidate =
      longest !== null && longest.turnId === message.turnId
        ? secondLongest
        : longest;
    if (
      candidate !== null &&
      isExternalUserBoundaryForTurn(candidate, message)
    ) {
      boundary = message.sequence;
      break;
    }
  }
  return {
    boundarySequence: boundary,
    boundaryScanThroughSequence,
    acceptedTurnIds: new Map(
      [...accepted].map(([requestId, entry]) => [requestId, entry.turnId]),
    ),
  };
}

export function orderTimelineRowsUsingContext(
  rows: readonly TimelineRow[],
  boundary: number | null,
): TimelineRow[] {
  if (boundary === null) return [...rows];
  const index = rows.findIndex((row) => row.sourceSeqStart >= boundary);
  if (index < 0) return [...rows];
  return [
    ...rows.slice(0, index),
    ...rows
      .slice(index)
      .sort(
        (left, right) =>
          left.sourceSeqStart - right.sourceSeqStart ||
          left.sourceSeqEnd - right.sourceSeqEnd,
      ),
  ];
}
