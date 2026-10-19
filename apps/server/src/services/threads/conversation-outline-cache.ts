import {
  getDatabaseDataVersion,
  getThreadEventRewriteGeneration,
  type DbConnection,
} from "@bb/db";
import {
  threadConversationOutlineItemSchema,
  type ThreadConversationOutlineItem,
} from "@bb/server-contract";
import {
  MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION,
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import { z } from "zod";
import {
  clearPersistedCheckpoint,
  persistedCheckpointChars,
  readPersistedCheckpoint,
  writePersistedCheckpoint,
  type PersistedCheckpointChain,
} from "./persisted-checkpoint.js";

interface ProjectedOutlineItem {
  item: ThreadConversationOutlineItem;
  sourceSeqStart: number;
  sourceSeqEnd: number;
}

export interface ConversationOutlineProjection {
  externalUserBoundarySeq: number | null;
  items: ProjectedOutlineItem[];
  pendingSteerItems: ProjectedOutlineItem[];
}

export interface ConversationOutlineSelection {
  events: ThreadEventWithMeta[];
  project: () => ConversationOutlineProjection;
}

export interface ConversationOutlinePrefix {
  agentMessageDeltaCount: number;
  externalUserBoundarySeq: number | null;
  sequenceStart: number;
}

export interface ConversationOutlineProjectionState {
  includeNestedEvents: boolean;
  summaryCompactionEnabled: boolean;
}

interface Checkpoint extends ConversationOutlinePrefix {
  identities: Set<string>;
  items: ThreadConversationOutlineItem[];
  pendingSteerItems: ThreadConversationOutlineItem[];
}

export type ConversationOutlineCheckpointSource =
  | "memory"
  | "persisted"
  | "full";

interface EntryHeader {
  agentMessageDeltaCount: number;
  historySequenceStart: number;
  key: string;
  maxSeq: number;
  projectionState: ConversationOutlineProjectionState;
}

interface Entry extends EntryHeader {
  chain: PersistedCheckpointChain;
  checkpoint: Checkpoint;
  dataVersion: number;
  generation: number;
  source: Exclude<ConversationOutlineCheckpointSource, "full">;
}

interface OutlineCache {
  entries: Map<string, Entry>;
  chars: number;
}

const caches = new WeakMap<DbConnection, OutlineCache>();
const MAX_ENTRIES = 16;
const MAX_CHARS = 8_000_000;
const PERSISTED_CHECKPOINT_KIND = "conversation-outline";

const persistedPartSchema = z.object({
  agentMessageDeltaCount: z.number().int().nonnegative(),
  checkpoint: z.object({
    agentMessageDeltaCount: z.number().int().nonnegative(),
    externalUserBoundarySeq: z.number().int().nullable(),
    sequenceStart: z.number().int(),
  }),
  historySequenceStart: z.number().int(),
  identities: z.array(z.string()),
  items: z.array(threadConversationOutlineItemSchema),
  key: z.string(),
  maxSeq: z.number().int(),
  pendingSteerItems: z.array(threadConversationOutlineItemSchema),
  previousSequenceStart: z.number().int(),
  projectionState: z.object({
    includeNestedEvents: z.boolean(),
    summaryCompactionEnabled: z.boolean(),
  }),
});

type PersistedPart = z.infer<typeof persistedPartSchema>;

function emptyCheckpoint(sequenceStart: number): Checkpoint {
  return {
    agentMessageDeltaCount: 0,
    externalUserBoundarySeq: null,
    identities: new Set(),
    items: [],
    pendingSteerItems: [],
    sequenceStart,
  };
}

function toPersistedPart(
  header: EntryHeader,
  previous: Checkpoint,
  next: Checkpoint,
): PersistedPart {
  return {
    ...header,
    checkpoint: {
      agentMessageDeltaCount: next.agentMessageDeltaCount,
      externalUserBoundarySeq: next.externalUserBoundarySeq,
      sequenceStart: next.sequenceStart,
    },
    identities: [...next.identities].slice(previous.identities.size),
    items: next.items.slice(previous.items.length),
    pendingSteerItems: next.pendingSteerItems.slice(
      previous.pendingSteerItems.length,
    ),
    previousSequenceStart: previous.sequenceStart,
  };
}

function readPersistedEntry(
  db: DbConnection,
  threadId: string,
  current: { dataVersion: number; generation: number },
): Entry | null {
  const persisted = readPersistedCheckpoint(
    db,
    { kind: PERSISTED_CHECKPOINT_KIND, threadId },
    persistedPartSchema,
  );
  if (persisted === null) return null;
  const first = persisted.parts[0]!;
  const checkpoint = emptyCheckpoint(first.historySequenceStart);
  for (const part of persisted.parts) {
    if (
      part.key !== first.key ||
      part.historySequenceStart !== first.historySequenceStart ||
      part.previousSequenceStart !== checkpoint.sequenceStart ||
      part.checkpoint.sequenceStart <= checkpoint.sequenceStart
    )
      return null;
    for (const item of part.items) checkpoint.items.push(item);
    for (const item of part.pendingSteerItems)
      checkpoint.pendingSteerItems.push(item);
    for (const identity of part.identities) checkpoint.identities.add(identity);
    checkpoint.agentMessageDeltaCount = part.checkpoint.agentMessageDeltaCount;
    checkpoint.externalUserBoundarySeq =
      part.checkpoint.externalUserBoundarySeq;
    checkpoint.sequenceStart = part.checkpoint.sequenceStart;
  }
  const last = persisted.parts.at(-1)!;
  return {
    agentMessageDeltaCount: last.agentMessageDeltaCount,
    chain: persisted.chain,
    checkpoint,
    dataVersion: current.dataVersion,
    generation: current.generation,
    historySequenceStart: last.historySequenceStart,
    key: last.key,
    maxSeq: last.maxSeq,
    projectionState: last.projectionState,
    source: "persisted",
  };
}

function eventIdentities(event: ThreadEventWithMeta["event"]): string[] {
  const identities: string[] = [];
  if (event.scope.kind === "turn")
    identities.push(`turn:${event.scope.turnId}`);
  if (
    event.type === "client/turn/requested" ||
    event.type === "client/turn/rejected"
  )
    identities.push(`request:${event.requestId}`);
  if (
    event.type === "client/turn/requested" &&
    "expectedTurnId" in event.target &&
    event.target.expectedTurnId !== null
  )
    identities.push(`turn:${event.target.expectedTurnId}`);
  if (event.type === "turn/input/accepted")
    identities.push(`request:${event.clientRequestId}`);
  if ("item" in event) {
    identities.push(`item:${event.item.id}`);
    if ("parentToolCallId" in event.item && event.item.parentToolCallId != null)
      identities.push(`item:${event.item.parentToolCallId}`);
  }
  if ("itemId" in event) identities.push(`item:${event.itemId}`);
  if ("parentToolCallId" in event && event.parentToolCallId != null)
    identities.push(`item:${event.parentToolCallId}`);
  return identities;
}

function isThreadError(event: ThreadEventWithMeta["event"]): boolean {
  return (
    event.scope.kind === "thread" &&
    (event.type === "system/error" ||
      event.type === "provider/error" ||
      event.type === "system/thread/interrupted")
  );
}

function canReuse(
  checkpoint: Checkpoint,
  events: ThreadEventWithMeta[],
): boolean {
  let hasTailTurn = false;
  return events.every(({ event }) => {
    if (event.type === "turn/started") hasTailTurn = true;
    if (isThreadError(event) && !hasTailTurn) return false;
    return eventIdentities(event).every(
      (identity) => !checkpoint.identities.has(identity),
    );
  });
}

function checkpointAt(
  events: ThreadEventWithMeta[],
  projection: ConversationOutlineProjection,
  previous: Checkpoint,
  boundary: number,
): Checkpoint | null {
  const identities = new Set(previous.identities);
  let agentMessageDeltaCount = previous.agentMessageDeltaCount;
  for (const { event, meta } of events) {
    if (meta.seq >= boundary) break;
    for (const identity of eventIdentities(event)) identities.add(identity);
    if (event.type === "item/agentMessage/delta") agentMessageDeltaCount += 1;
  }
  const checkpoint: Checkpoint = {
    agentMessageDeltaCount,
    externalUserBoundarySeq:
      projection.externalUserBoundarySeq !== null &&
      projection.externalUserBoundarySeq < boundary
        ? projection.externalUserBoundarySeq
        : null,
    identities,
    items: previous.items,
    pendingSteerItems: previous.pendingSteerItems,
    sequenceStart: boundary,
  };
  const tailEvents = events.filter(({ meta }) => meta.seq >= boundary);
  if (!canReuse(checkpoint, tailEvents)) return null;
  const items = frozenBefore(projection.items, boundary);
  const pendingSteerItems = frozenBefore(
    projection.pendingSteerItems,
    boundary,
  );
  if (items === null || pendingSteerItems === null) return null;
  checkpoint.items = [...previous.items, ...items];
  checkpoint.pendingSteerItems = [
    ...previous.pendingSteerItems,
    ...pendingSteerItems,
  ];
  return checkpoint;
}

function frozenBefore(
  items: ProjectedOutlineItem[],
  boundary: number,
): ThreadConversationOutlineItem[] | null {
  let reachedTail = false;
  const frozen: ThreadConversationOutlineItem[] = [];
  for (const { item, sourceSeqStart, sourceSeqEnd } of items) {
    if (sourceSeqStart >= boundary) reachedTail = true;
    else {
      if (reachedTail || sourceSeqEnd >= boundary) return null;
      frozen.push(item);
    }
  }
  return frozen;
}

function nextCheckpoint(
  events: ThreadEventWithMeta[],
  projection: ConversationOutlineProjection,
  previous: Checkpoint,
): Checkpoint {
  const activeTurns = new Set<string>();
  const pendingRequests = new Set<string>();
  const candidates: number[] = [];
  const firstSeen = new Map<string, number>();
  const earliestReferences: number[] = [];
  let completedBoundary = previous.sequenceStart;
  let boundary = previous.sequenceStart;
  for (const { event, meta } of events) {
    let earliestReference = Infinity;
    for (const identity of eventIdentities(event)) {
      const seen = firstSeen.get(identity) ?? meta.seq;
      firstSeen.set(identity, seen);
      earliestReference = Math.min(earliestReference, seen);
    }
    earliestReferences.push(earliestReference);
    if (isThreadError(event)) {
      completedBoundary = boundary;
    }
    if (
      event.type === "client/turn/requested" &&
      (event.target.kind === "steer" ||
        (event.target.kind === "auto" && event.target.expectedTurnId !== null))
    )
      pendingRequests.add(event.requestId);
    if (event.type === "turn/input/accepted")
      pendingRequests.delete(event.clientRequestId);
    if (event.type === "client/turn/rejected")
      pendingRequests.delete(event.requestId);
    if (event.scope.kind !== "turn") continue;
    if (event.type === "turn/started") {
      if (activeTurns.size === 0 && completedBoundary > boundary) {
        boundary = completedBoundary;
        candidates.push(boundary);
      }
      activeTurns.add(event.scope.turnId);
    }
    if (event.type === "turn/completed") {
      activeTurns.delete(event.scope.turnId);
      if (activeTurns.size === 0 && pendingRequests.size === 0)
        completedBoundary = meta.seq + 1;
    }
  }
  for (let index = earliestReferences.length - 2; index >= 0; index -= 1)
    earliestReferences[index] = Math.min(
      earliestReferences[index]!,
      earliestReferences[index + 1]!,
    );
  let tailStart = events.length;
  for (const candidate of candidates.reverse()) {
    while (tailStart > 0 && events[tailStart - 1]!.meta.seq >= candidate)
      tailStart -= 1;
    if (earliestReferences[tailStart]! < candidate) continue;
    return checkpointAt(events, projection, previous, candidate) ?? previous;
  }
  return previous;
}

export function projectConversationOutlineIncrementally(args: {
  db: DbConnection;
  threadId: string;
  key: string;
  maxSeq: number;
  historySequenceStart: number;
  resolveProjectionState: (
    sequenceStart: number,
    previous: ConversationOutlineProjectionState | null,
  ) => ConversationOutlineProjectionState;
  select: (
    prefix: ConversationOutlinePrefix,
    projectionState: ConversationOutlineProjectionState,
  ) => ConversationOutlineSelection;
}): {
  items: ThreadConversationOutlineItem[];
  source: ConversationOutlineCheckpointSource;
} {
  let cache = caches.get(args.db);
  if (cache === undefined) {
    cache = { entries: new Map(), chars: 0 };
    caches.set(args.db, cache);
  }
  const persistedKey = {
    kind: PERSISTED_CHECKPOINT_KIND,
    threadId: args.threadId,
  };
  const dataVersion = getDatabaseDataVersion(args.db);
  const generation = getThreadEventRewriteGeneration(args.threadId);
  const cached = cache.entries.get(args.threadId);
  if (cached !== undefined) {
    cache.entries.delete(args.threadId);
    cache.chars -= persistedCheckpointChars(cached.chain);
  }
  const entry =
    cached ??
    readPersistedEntry(args.db, args.threadId, { dataVersion, generation }) ??
    undefined;
  const empty = emptyCheckpoint(args.historySequenceStart);
  const canReuseEntry =
    entry !== undefined &&
    entry.key === args.key &&
    entry.dataVersion === dataVersion &&
    entry.generation === generation &&
    entry.historySequenceStart === args.historySequenceStart &&
    entry.maxSeq <= args.maxSeq;
  const previousState = canReuseEntry ? entry.projectionState : null;
  const projectionState = args.resolveProjectionState(
    canReuseEntry ? entry.maxSeq + 1 : args.historySequenceStart,
    previousState,
  );
  let checkpoint =
    canReuseEntry &&
    previousState?.includeNestedEvents ===
      projectionState.includeNestedEvents &&
    previousState.summaryCompactionEnabled ===
      projectionState.summaryCompactionEnabled
      ? entry.checkpoint
      : empty;
  let selection = args.select(checkpoint, projectionState);
  let agentMessageDeltaCount =
    checkpoint.agentMessageDeltaCount +
    selection.events.filter(
      ({ event }) => event.type === "item/agentMessage/delta",
    ).length;
  const crossedCompactionThreshold =
    entry !== undefined &&
    entry.agentMessageDeltaCount <
      MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION &&
    agentMessageDeltaCount >= MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION;
  if (
    checkpoint !== empty &&
    (crossedCompactionThreshold || !canReuse(checkpoint, selection.events))
  ) {
    checkpoint = empty;
    selection = args.select(checkpoint, projectionState);
    agentMessageDeltaCount = selection.events.filter(
      ({ event }) => event.type === "item/agentMessage/delta",
    ).length;
  }
  const projection = selection.project();
  const items = [
    ...checkpoint.items,
    ...projection.items.map(({ item }) => item),
    ...checkpoint.pendingSteerItems,
    ...projection.pendingSteerItems.map(({ item }) => item),
  ];
  const source =
    checkpoint === empty || entry === undefined ? "full" : entry.source;
  const next = nextCheckpoint(selection.events, projection, checkpoint);
  if (next.sequenceStart <= args.historySequenceStart) {
    if (entry !== undefined) clearPersistedCheckpoint(args.db, persistedKey);
    return { items, source };
  }
  const header: EntryHeader = {
    agentMessageDeltaCount,
    historySequenceStart: args.historySequenceStart,
    key: args.key,
    maxSeq: args.maxSeq,
    projectionState,
  };
  const extendsEntry = entry !== undefined && checkpoint === entry.checkpoint;
  const chain =
    extendsEntry && next === checkpoint
      ? entry.chain
      : writePersistedCheckpoint(args.db, persistedKey, {
          chain: extendsEntry ? entry.chain : null,
          full: () => toPersistedPart(header, empty, next),
          maxChars: MAX_CHARS,
          part: extendsEntry
            ? () => toPersistedPart(header, checkpoint, next)
            : null,
        });
  if (chain !== null) {
    cache.entries.set(args.threadId, {
      ...header,
      chain,
      checkpoint: next,
      dataVersion,
      generation,
      source: "memory",
    });
    cache.chars += persistedCheckpointChars(chain);
  }
  while (cache.entries.size > MAX_ENTRIES || cache.chars > MAX_CHARS) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.chars -= persistedCheckpointChars(cache.entries.get(oldest)!.chain);
    cache.entries.delete(oldest);
  }
  return { items, source };
}
