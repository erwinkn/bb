import { describe, expect, it } from "vitest";
import type { DbConnection } from "../../src/connection.js";
import {
  getDatabaseFreelistStats,
  runIncrementalVacuum,
  runIncrementalVacuumInChunks,
} from "../../src/data/maintenance.js";
import { createMigratedConnection } from "../../src/testing.js";

function createFreelist(rowCount: number): DbConnection {
  const db = createMigratedConnection();
  db.$client.exec(
    "CREATE TABLE scratch_blobs (id INTEGER PRIMARY KEY, blob TEXT)",
  );
  const insert = db.$client.prepare(
    "INSERT INTO scratch_blobs (blob) VALUES (?)",
  );
  const blob = "x".repeat(8 * 1024);
  db.$client.transaction(() => {
    for (let index = 0; index < rowCount; index += 1) insert.run(blob);
  })();
  db.$client.exec("DELETE FROM scratch_blobs");
  return db;
}

describe("runIncrementalVacuumInChunks", () => {
  it("frees as many pages as one call, yielding between chunks", async () => {
    const single = createFreelist(400);
    const chunked = createFreelist(400);
    const freelist = getDatabaseFreelistStats(chunked).freelistCount;
    expect(freelist).toBeGreaterThan(300);
    let yields = 0;

    const one = runIncrementalVacuum(single, { maxPages: 250 });
    const result = await runIncrementalVacuumInChunks(chunked, {
      chunkPages: 60,
      maxPages: 250,
      yieldBetweenChunks: async () => {
        yields += 1;
      },
    });

    expect(result.before.freelistCount).toBe(freelist);
    expect(result.before.freelistCount - result.after.freelistCount).toBe(
      one.before.freelistCount - one.after.freelistCount,
    );
    expect(result.before.freelistCount - result.after.freelistCount).toBe(250);
    expect(result.chunks).toBe(5);
    expect(yields).toBe(4);
  });

  it("stops once the freelist is empty", async () => {
    const db = createFreelist(40);
    const freelist = getDatabaseFreelistStats(db).freelistCount;
    let yields = 0;

    const result = await runIncrementalVacuumInChunks(db, {
      chunkPages: 25,
      maxPages: 20_000,
      yieldBetweenChunks: async () => {
        yields += 1;
      },
    });

    expect(result.after.freelistCount).toBe(0);
    expect(result.chunks).toBe(Math.ceil((freelist + 1) / 25));
    expect(yields).toBe(result.chunks - 1);
  });
});
