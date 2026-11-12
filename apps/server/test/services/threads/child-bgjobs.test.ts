import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));
vi.unmock("../../../src/services/threads/child-bgjobs.js");

import {
  listThreadsAwaitingBgjob,
  parseBgjobThreadIds,
} from "../../../src/services/threads/child-bgjobs.js";

const LIST_UNITS = [
  "bgjob-thr_alpha-20261112T163121Z-1833412.service loaded active running /home/erwin/.bb/bin/bgjob --run /x",
  "bgjob-thr_alpha-20261112T170000Z-42.service loaded active running /home/erwin/.bb/bin/bgjob --run /z",
  "bgjob-thr_beta-20261112T164606Z-3308167.service loaded deactivating stop-sigterm /home/erwin/.bb/bin/bgjob --run /y",
  "bgjob-nothread.service loaded active running something else",
  "",
].join("\n");

type ExecFileCallback = (error: Error | null, stdout: string) => void;

function answerSystemctl(error: Error | null, stdout = ""): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: ExecFileCallback,
    ) => callback(error, stdout),
  );
}

afterEach(() => {
  execFileMock.mockReset();
});

describe("bgjob units", () => {
  it("parses thread ids from systemctl list-units", () => {
    expect(parseBgjobThreadIds(LIST_UNITS)).toEqual(
      new Set(["thr_alpha", "thr_beta"]),
    );
  });

  it.runIf(process.platform === "linux")(
    "asks systemd for the active bgjob units",
    async () => {
      answerSystemctl(null, LIST_UNITS);
      expect(await listThreadsAwaitingBgjob()).toEqual(
        new Set(["thr_alpha", "thr_beta"]),
      );
      const [file, args, options] = execFileMock.mock.calls[0] ?? [];
      expect(file).toBe("systemctl");
      expect(args).toContain("bgjob-*");
      expect(options).toMatchObject({ timeout: 5_000 });
    },
  );

  it.runIf(process.platform === "linux")(
    "asks only for units still running",
    async () => {
      answerSystemctl(null, "");
      await listThreadsAwaitingBgjob();
      const [, args] = execFileMock.mock.calls[0] ?? [];
      expect(args).toContain("--state=active,activating");
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects when systemctl fails",
    async () => {
      answerSystemctl(new Error("Failed to connect to bus"));
      await expect(listThreadsAwaitingBgjob()).rejects.toThrow(
        "Failed to connect to bus",
      );
      expect(execFileMock).toHaveBeenCalledOnce();
    },
  );

  it.skipIf(process.platform === "linux")(
    "finds none off Linux without running systemctl",
    async () => {
      expect(await listThreadsAwaitingBgjob()).toEqual(new Set());
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );
});
