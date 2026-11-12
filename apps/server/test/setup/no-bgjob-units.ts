import { vi } from "vitest";

vi.mock(
  "../../src/services/threads/child-bgjobs.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/services/threads/child-bgjobs.js")
    >()),
    listThreadsAwaitingBgjob: vi.fn(async () => new Set<string>()),
  }),
);
