import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { sdk } from "@/lib/sdk";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { threadQueryKey, threadsQueryKey } from "./query-keys";
import { resolveThreadProjectId } from "./thread-queries";

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { get: vi.fn() } },
}));

afterEach(() => {
  vi.mocked(sdk.threads.get).mockReset();
});

describe("resolveThreadProjectId", () => {
  it("answers from a cached thread list without fetching", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(threadsQueryKey(), [
      makeThreadListEntry({ id: "thr_listed", projectId: "proj_listed" }),
    ]);

    await expect(
      resolveThreadProjectId(queryClient, "thr_listed"),
    ).resolves.toBe("proj_listed");
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });

  it("fetches an uncached thread once, into the cache the thread view reads", async () => {
    const queryClient = new QueryClient();
    const thread = makeThreadResponse({
      id: "thr_unlisted",
      projectId: "proj_unlisted",
    });
    vi.mocked(sdk.threads.get).mockResolvedValue(thread);

    await expect(
      resolveThreadProjectId(queryClient, "thr_unlisted"),
    ).resolves.toBe("proj_unlisted");
    await expect(
      resolveThreadProjectId(queryClient, "thr_unlisted"),
    ).resolves.toBe("proj_unlisted");

    expect(sdk.threads.get).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(threadQueryKey("thr_unlisted"))).toBe(
      thread,
    );
  });
});
