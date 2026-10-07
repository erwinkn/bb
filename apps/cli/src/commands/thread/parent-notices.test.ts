import { describe, expect, it } from "vitest";
import { resolveParentNoticesOption } from "./parent-notices.js";

describe("resolveParentNoticesOption", () => {
  it.each([
    [{}, undefined],
    [{ parentNotices: "turns" }, "turns"],
    [{ parentNotices: "explicit" }, "explicit"],
    [{ finalReportsOnly: true }, "explicit"],
    [{ finalReportsOnly: true, parentNotices: "explicit" }, "explicit"],
  ] as const)("resolves %j to %s", (flags, expected) => {
    expect(resolveParentNoticesOption(flags)).toBe(expected);
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      resolveParentNoticesOption({ parentNotices: "final" }),
    ).toThrow("--parent-notices must be turns or explicit.");
  });

  it("rejects --final-reports-only with --parent-notices turns", () => {
    expect(() =>
      resolveParentNoticesOption({
        finalReportsOnly: true,
        parentNotices: "turns",
      }),
    ).toThrow(
      "Cannot combine --final-reports-only with --parent-notices turns.",
    );
  });
});
