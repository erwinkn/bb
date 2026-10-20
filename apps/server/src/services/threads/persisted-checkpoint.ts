import {
  appendThreadTimelineCheckpointPart,
  listThreadTimelineCheckpointParts,
  replaceThreadTimelineCheckpoint,
  type DbConnection,
} from "@bb/db";
import type { z } from "zod";

export interface PersistedCheckpointKey {
  kind: string;
  threadId: string;
}

export interface PersistedCheckpointChain {
  appendedChars: number;
  baseChars: number;
  parts: number;
}

const MAX_PERSISTED_CHECKPOINT_PARTS = 64;

export function persistedCheckpointChars(
  chain: PersistedCheckpointChain,
): number {
  return chain.baseChars + chain.appendedChars;
}

// Reads a chain and hands its decoded parts to `assemble`, which checks
// linkage across parts. A chain that fails any check is deleted, so a corrupt
// or foreign chain is parsed once rather than on every load.
export function readPersistedCheckpoint<T, R>(
  db: DbConnection,
  key: PersistedCheckpointKey,
  schema: z.ZodType<T>,
  assemble: (parts: T[], chain: PersistedCheckpointChain) => R | null,
): R | null {
  const rows = listThreadTimelineCheckpointParts(db, key);
  if (rows.length === 0) return null;
  const result = decodePersistedCheckpoint(rows, schema, assemble);
  if (result === null) clearPersistedCheckpoint(db, key);
  return result;
}

function decodePersistedCheckpoint<T, R>(
  rows: { part: number; payload: string }[],
  schema: z.ZodType<T>,
  assemble: (parts: T[], chain: PersistedCheckpointChain) => R | null,
): R | null {
  const parts: T[] = [];
  let appendedChars = 0;
  for (const [index, row] of rows.entries()) {
    if (row.part !== index) return null;
    let json: unknown;
    try {
      json = JSON.parse(row.payload);
    } catch {
      return null;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return null;
    parts.push(parsed.data);
    if (index > 0) appendedChars += row.payload.length;
  }
  return assemble(parts, {
    appendedChars,
    baseChars: rows[0]!.payload.length,
    parts: rows.length,
  });
}

export function writePersistedCheckpoint(
  db: DbConnection,
  key: PersistedCheckpointKey,
  args: {
    chain: PersistedCheckpointChain | null;
    full: () => unknown;
    maxChars: number;
    part: (() => unknown) | null;
  },
): PersistedCheckpointChain | null {
  const { chain, part } = args;
  if (
    chain !== null &&
    part !== null &&
    chain.parts < MAX_PERSISTED_CHECKPOINT_PARTS
  ) {
    const payload = JSON.stringify(part());
    if (
      chain.appendedChars + payload.length <= chain.baseChars &&
      persistedCheckpointChars(chain) + payload.length <= args.maxChars &&
      appendThreadTimelineCheckpointPart(db, {
        ...key,
        part: chain.parts,
        payload,
      })
    ) {
      return {
        appendedChars: chain.appendedChars + payload.length,
        baseChars: chain.baseChars,
        parts: chain.parts + 1,
      };
    }
  }
  const payload = JSON.stringify(args.full());
  if (payload.length > args.maxChars) {
    replaceThreadTimelineCheckpoint(db, { ...key, payload: null });
    return null;
  }
  replaceThreadTimelineCheckpoint(db, { ...key, payload });
  return { appendedChars: 0, baseChars: payload.length, parts: 1 };
}

export function clearPersistedCheckpoint(
  db: DbConnection,
  key: PersistedCheckpointKey,
): void {
  replaceThreadTimelineCheckpoint(db, { ...key, payload: null });
}
