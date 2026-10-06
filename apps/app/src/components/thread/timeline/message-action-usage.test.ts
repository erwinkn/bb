import { describe, expect, it } from "vitest";
import {
  messageActionScore,
  rankInlineMessageActions,
  recordMessageActionUsage,
  type MessageActionUsage,
} from "./message-action-usage";

const NOW = Date.UTC(2026, 9, 5, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

function action(usageKey: string, promotable: boolean) {
  return { usageKey, promotable };
}

function rankedKeys(
  actions: readonly { usageKey: string; promotable: boolean }[],
  usage: MessageActionUsage,
) {
  return rankInlineMessageActions({ actions, usage, now: NOW }).map(
    (ranked) => ranked.usageKey,
  );
}

describe("message action usage", () => {
  it("halves an action's score every two weeks without use", () => {
    const usage = recordMessageActionUsage({}, "fork", NOW - 14 * DAY_MS);

    expect(messageActionScore(usage, "fork", NOW)).toBeCloseTo(0.5);
    expect(messageActionScore(usage, "copy", NOW)).toBe(0);
  });

  it("adds each use to the decayed score", () => {
    const first = recordMessageActionUsage({}, "fork", NOW - 14 * DAY_MS);
    const second = recordMessageActionUsage(first, "fork", NOW);

    expect(second.fork).toEqual({ score: 1.5, usedAt: NOW });
  });

  it("keeps only the highest-scoring actions once the record is full", () => {
    let usage: MessageActionUsage = {};
    for (let index = 0; index < 64; index += 1) {
      usage = recordMessageActionUsage(usage, `plugin:${index}`, NOW);
      usage = recordMessageActionUsage(usage, `plugin:${index}`, NOW);
    }
    usage = recordMessageActionUsage(usage, "fork", NOW);

    expect(Object.keys(usage)).toHaveLength(64);
    expect(usage.fork).toBeUndefined();
  });

  it("keeps the default row when nothing has been used", () => {
    expect(
      rankedKeys(
        [
          action("copy", false),
          action("edit", false),
          action("copy-link", true),
          action("add-to-chat", true),
        ],
        {},
      ),
    ).toEqual(["copy", "edit"]);
  });

  it("promotes a menu action only after repeated recent use", () => {
    const actions = [action("copy", false), action("fork", true)];
    const once = recordMessageActionUsage({}, "fork", NOW);
    const twice = recordMessageActionUsage(once, "fork", NOW);

    expect(rankedKeys(actions, once)).toEqual(["copy"]);
    expect(rankedKeys(actions, twice)).toEqual(["fork", "copy"]);
  });

  it("fills at most three slots and lets heavy use outrank unused defaults", () => {
    const usage: MessageActionUsage = {
      "add-to-chat": { score: 5, usedAt: NOW },
      "copy-link": { score: 4, usedAt: NOW },
      copy: { score: 3, usedAt: NOW },
    };

    expect(
      rankedKeys(
        [
          action("copy", false),
          action("edit", false),
          action("copy-link", true),
          action("add-to-chat", true),
        ],
        usage,
      ),
    ).toEqual(["add-to-chat", "copy-link", "copy"]);
  });

  it("never shrinks the default row when more than three defaults exist", () => {
    expect(
      rankedKeys(
        [
          action("copy", false),
          action("edit", false),
          action("plugin:a", false),
          action("plugin:b", false),
          action("fork", true),
        ],
        { fork: { score: 9, usedAt: NOW } },
      ),
    ).toEqual(["fork", "copy", "edit", "plugin:a"]);
  });
});
