import {
  getDatabaseDataVersion,
  getThreadEventRewriteGeneration,
  listLatestBackgroundTaskStateSequencesInRange,
  listStoredEventRowsByParentToolCallIds,
  listStoredTimelineTurnEventRows,
  type DbConnection,
  type InlineOutputCharLimit,
  type StoredEventRow,
} from "@bb/db";
import type { ThreadEventType } from "@bb/domain";

export interface TimelineRowQuery {
  beforeSequence: number | undefined;
  excludeDiagnosticEvents: boolean;
  excludedTypes: readonly ThreadEventType[];
  maxInlineOutputChars: InlineOutputCharLimit;
  sequenceStart: number | undefined;
  threadId: string;
}

export interface TimelineRowSource {
  listParentedRows(
    db: DbConnection,
    args: TimelineRowQuery & { parentToolCallIds: readonly string[] },
  ): StoredEventRow[];
  listTurnRows(
    db: DbConnection,
    args: TimelineRowQuery & {
      sequenceStart: number;
      turnIds: readonly string[];
    },
  ): StoredEventRow[];
}

interface RowGroupKind {
  name: "parent" | "turn";
  groupIdOf(row: StoredEventRow): string | null;
  query(
    db: DbConnection,
    args: TimelineRowQuery & { sequenceStart: number },
    ids: readonly string[],
  ): StoredEventRow[];
}

interface CachedRowGroup {
  dataChars: number;
  rows: readonly StoredEventRow[];
  threadId: string;
  throughSequence: number;
}

interface ThreadValidity {
  dataVersion: number;
  generation: number;
}

interface TimelineRowCache {
  dataChars: number;
  groups: Map<string, CachedRowGroup>;
  validity: Map<string, ThreadValidity>;
}

export const TIMELINE_ROW_CACHE_MAX_GROUPS = 4_096;
export const TIMELINE_ROW_CACHE_MAX_DATA_CHARS = 32_000_000;

const BACKGROUND_TASK_PROGRESS_TYPE = "item/backgroundTask/progress";

const rowCaches = new WeakMap<DbConnection, TimelineRowCache>();

const TURN_ROWS: RowGroupKind = {
  name: "turn",
  groupIdOf: (row) => row.turnId,
  query: (db, args, turnIds) =>
    listStoredTimelineTurnEventRows(db, { ...args, turnIds }),
};

const PARENTED_ROWS: RowGroupKind = {
  name: "parent",
  groupIdOf: (row) => row.parentToolCallId,
  query: (db, args, parentToolCallIds) =>
    listStoredEventRowsByParentToolCallIds(db, { ...args, parentToolCallIds }),
};

export const directTimelineRowSource: TimelineRowSource = {
  listParentedRows: (db, args) =>
    listStoredEventRowsByParentToolCallIds(db, args),
  listTurnRows: (db, args) => listStoredTimelineTurnEventRows(db, args),
};

export const cachedTimelineRowSource: TimelineRowSource = {
  listParentedRows: (db, args) =>
    args.sequenceStart === undefined
      ? listStoredEventRowsByParentToolCallIds(db, args)
      : listCachedRows(
          db,
          PARENTED_ROWS,
          { ...args, sequenceStart: args.sequenceStart },
          args.parentToolCallIds,
        ),
  listTurnRows: (db, args) => listCachedRows(db, TURN_ROWS, args, args.turnIds),
};

export function clearTimelineRowCache(db: DbConnection): void {
  rowCaches.delete(db);
}

export function readTimelineRowCacheSize(db: DbConnection): {
  dataChars: number;
  groupCount: number;
} {
  const cache = rowCaches.get(db);
  return {
    dataChars: cache?.dataChars ?? 0,
    groupCount: cache?.groups.size ?? 0,
  };
}

export function forgetTimelineRows(db: DbConnection, threadId: string): void {
  const cache = rowCaches.get(db);
  if (cache === undefined) return;
  cache.validity.delete(threadId);
  for (const [key, group] of cache.groups) {
    if (group.threadId === threadId) deleteGroup(cache, key);
  }
}

function getRowCache(db: DbConnection): TimelineRowCache {
  let cache = rowCaches.get(db);
  if (cache === undefined) {
    cache = { dataChars: 0, groups: new Map(), validity: new Map() };
    rowCaches.set(db, cache);
  }
  return cache;
}

function deleteGroup(cache: TimelineRowCache, key: string): void {
  const group = cache.groups.get(key);
  if (group === undefined) return;
  cache.groups.delete(key);
  cache.dataChars -= group.dataChars;
}

function storeGroup(
  cache: TimelineRowCache,
  key: string,
  group: CachedRowGroup,
): void {
  deleteGroup(cache, key);
  if (group.dataChars > TIMELINE_ROW_CACHE_MAX_DATA_CHARS) return;
  cache.groups.set(key, group);
  cache.dataChars += group.dataChars;
  while (
    cache.groups.size > TIMELINE_ROW_CACHE_MAX_GROUPS ||
    cache.dataChars > TIMELINE_ROW_CACHE_MAX_DATA_CHARS
  ) {
    const oldest = cache.groups.keys().next().value;
    if (oldest === undefined) break;
    deleteGroup(cache, oldest);
  }
}

function touchGroup(
  cache: TimelineRowCache,
  key: string,
  group: CachedRowGroup,
): void {
  cache.groups.delete(key);
  cache.groups.set(key, group);
}

function dataCharsOf(rows: readonly StoredEventRow[]): number {
  let chars = 0;
  for (const row of rows) chars += row.data.length;
  return chars;
}

function ensureThreadValidity(
  db: DbConnection,
  cache: TimelineRowCache,
  threadId: string,
): void {
  const current: ThreadValidity = {
    dataVersion: getDatabaseDataVersion(db),
    generation: getThreadEventRewriteGeneration(threadId),
  };
  const known = cache.validity.get(threadId);
  if (
    known !== undefined &&
    known.dataVersion === current.dataVersion &&
    known.generation === current.generation
  ) {
    return;
  }
  forgetTimelineRows(db, threadId);
  cache.validity.set(threadId, current);
}

function groupKey(
  kind: RowGroupKind,
  args: TimelineRowQuery & { sequenceStart: number },
  id: string,
): string {
  return JSON.stringify([
    args.threadId,
    kind.name,
    id,
    args.sequenceStart,
    args.excludeDiagnosticEvents,
    args.maxInlineOutputChars,
    args.excludedTypes,
  ]);
}

function rowsByGroupId(
  kind: RowGroupKind,
  rows: readonly StoredEventRow[],
): Map<string, StoredEventRow[]> {
  const grouped = new Map<string, StoredEventRow[]>();
  for (const row of rows) {
    const id = kind.groupIdOf(row);
    if (id === null) continue;
    const group = grouped.get(id);
    if (group === undefined) grouped.set(id, [row]);
    else group.push(row);
  }
  return grouped;
}

function isSupersededProgressRow(
  row: StoredEventRow,
  latestStateSequences: ReadonlyMap<string, number>,
): boolean {
  if (row.type !== BACKGROUND_TASK_PROGRESS_TYPE || row.itemId === null) {
    return false;
  }
  const latest = latestStateSequences.get(row.itemId);
  return latest !== undefined && latest > row.sequence;
}

interface RequestedGroup {
  cached: CachedRowGroup | undefined;
  id: string;
  key: string;
}

function listCachedRows(
  db: DbConnection,
  kind: RowGroupKind,
  args: TimelineRowQuery & { sequenceStart: number },
  ids: readonly string[],
): StoredEventRow[] {
  const uniqueIds = [...new Set(ids)];
  if (args.beforeSequence === undefined || uniqueIds.length === 0) {
    return kind.query(db, args, uniqueIds);
  }
  const throughSequence = args.beforeSequence - 1;
  const cache = getRowCache(db);
  ensureThreadValidity(db, cache, args.threadId);
  const requested: RequestedGroup[] = uniqueIds.map((id) => {
    const key = groupKey(kind, args, id);
    return { cached: cache.groups.get(key), id, key };
  });
  if (
    requested.some(
      ({ cached }) =>
        cached !== undefined && cached.throughSequence > throughSequence,
    )
  ) {
    return kind.query(db, args, uniqueIds);
  }
  const resolved = new Map<string, readonly StoredEventRow[]>();
  const staleByThrough = new Map<number, RequestedGroup[]>();
  const missing: RequestedGroup[] = [];
  for (const group of requested) {
    if (group.cached === undefined) {
      missing.push(group);
    } else if (group.cached.throughSequence === throughSequence) {
      touchGroup(cache, group.key, group.cached);
      resolved.set(group.id, group.cached.rows);
    } else {
      const stale = staleByThrough.get(group.cached.throughSequence);
      if (stale === undefined)
        staleByThrough.set(group.cached.throughSequence, [group]);
      else stale.push(group);
    }
  }
  const store = (group: RequestedGroup, rows: readonly StoredEventRow[]) => {
    resolved.set(group.id, rows);
    storeGroup(cache, group.key, {
      dataChars: dataCharsOf(rows),
      rows,
      threadId: args.threadId,
      throughSequence,
    });
  };
  if (staleByThrough.size > 0) {
    const latestStateSequences = listLatestBackgroundTaskStateSequencesInRange(
      db,
      {
        afterSequence: Math.min(...staleByThrough.keys()),
        beforeSequence: args.beforeSequence,
        threadId: args.threadId,
      },
    );
    for (const [cachedThrough, groups] of staleByThrough) {
      const appended = rowsByGroupId(
        kind,
        kind.query(
          db,
          {
            ...args,
            sequenceStart: Math.max(args.sequenceStart, cachedThrough + 1),
          },
          groups.map((group) => group.id),
        ),
      );
      for (const group of groups) {
        const kept =
          latestStateSequences.size === 0
            ? (group.cached?.rows ?? [])
            : (group.cached?.rows ?? []).filter(
                (row) => !isSupersededProgressRow(row, latestStateSequences),
              );
        store(group, kept.concat(appended.get(group.id) ?? []));
      }
    }
  }
  if (missing.length > 0) {
    const fetched = rowsByGroupId(
      kind,
      kind.query(
        db,
        args,
        missing.map((group) => group.id),
      ),
    );
    for (const group of missing) store(group, fetched.get(group.id) ?? []);
  }
  const rows: StoredEventRow[] = [];
  for (const id of uniqueIds) {
    for (const row of resolved.get(id) ?? []) rows.push(row);
  }
  return rows.sort((left, right) => left.sequence - right.sequence);
}
