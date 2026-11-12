import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_SKILL_PLUGIN_NAME,
  createClaudeSkillPluginsRoot,
  ensureClaudeSkillPlugin,
  withoutHiddenSkills,
} from "../skill-plugins.js";

describe("claude skill plugins", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "bb-claude-skill-plugins-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function stageSkills(name: string): string {
    const root = join(baseDir, `stage-${name}`, "skills");
    mkdirSync(join(root, "demo"), { recursive: true });
    writeFileSync(
      join(root, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: demo\n---\n",
    );
    return root;
  }

  it("is idempotent for a root and re-points the link when the root moves", () => {
    const pluginsRoot = createClaudeSkillPluginsRoot(baseDir);
    const first = stageSkills("a");
    const second = stageSkills("b");
    const pluginPath = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "r", path: first },
    });
    expect(pluginPath.startsWith(pluginsRoot)).toBe(true);
    expect(
      ensureClaudeSkillPlugin({ pluginsRoot, root: { id: "r", path: first } }),
    ).toBe(pluginPath);
    expect(readlinkSync(join(pluginPath, "skills"))).toBe(first);

    const movedPluginPath = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "r", path: second },
    });
    expect(movedPluginPath).not.toBe(pluginPath);
    expect(readlinkSync(join(movedPluginPath, "skills"))).toBe(second);
  });

  it("keeps the stable name across catalog changes and suffixes only a colliding second root", () => {
    const pluginsRoot = createClaudeSkillPluginsRoot(baseDir);
    const first = stageSkills("a");
    const second = stageSkills("b");
    const nameOf = (pluginPath: string): string =>
      (
        JSON.parse(
          readFileSync(
            join(pluginPath, ".claude-plugin", "plugin.json"),
            "utf8",
          ),
        ) as { name: string }
      ).name;

    expect(
      nameOf(
        ensureClaudeSkillPlugin({
          pluginsRoot,
          root: { id: "global-skills:aaaa", path: first },
        }),
      ),
    ).toBe(CLAUDE_SKILL_PLUGIN_NAME);
    expect(
      nameOf(
        ensureClaudeSkillPlugin({
          pluginsRoot,
          root: { id: "global-skills:bbbb", path: second },
        }),
      ),
    ).toBe(CLAUDE_SKILL_PLUGIN_NAME);

    const takenNames = new Map<string, string>();
    const a = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "global-skills:aaaa", path: first },
      takenNames,
    });
    const b = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "global-skills:bbbb", path: second },
      takenNames,
    });
    expect(nameOf(a)).toBe(CLAUDE_SKILL_PLUGIN_NAME);
    expect(nameOf(b)).toMatch(/^bb-global-skills-[0-9a-f]{8}$/u);
  });

  it("copies a plugin without its hidden skills, keeping it current", () => {
    const pluginsRoot = createClaudeSkillPluginsRoot(baseDir);
    const root = stageSkills("filtered");
    for (const skill of ["hidden", "later"]) {
      mkdirSync(join(root, skill));
    }
    const pluginPath = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "r", path: root },
    });
    const hide = (...skills: string[]) => new Set(skills);

    expect(withoutHiddenSkills(pluginPath, hide("absent"))).toBe(pluginPath);
    const filtered = withoutHiddenSkills(pluginPath, hide("hidden", "absent"));
    expect(filtered).not.toBe(pluginPath);
    expect(readdirSync(join(filtered, "skills")).sort()).toEqual(["demo", "later"]);
    expect(readlinkSync(join(filtered, "skills", "demo"))).toBe(join(root, "demo"));
    expect(
      readFileSync(join(filtered, ".claude-plugin", "plugin.json"), "utf8"),
    ).toBe(readFileSync(join(pluginPath, ".claude-plugin", "plugin.json"), "utf8"));

    // Same hidden set, same copy; it follows the root as skills come and go.
    rmSync(join(root, "later"), { recursive: true });
    mkdirSync(join(root, "added"));
    expect(withoutHiddenSkills(pluginPath, hide("hidden"))).toBe(filtered);
    expect(readdirSync(join(filtered, "skills")).sort()).toEqual(["added", "demo"]);
  });
});
