import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { claudeSetupRevision } from "../setup-revision.js";

let root: string;
let revision: () => Promise<string | null>;

function write(file: string, content: string): void {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bb-setup-revision-"));
  mkdirSync(join(root, "config"));
  mkdirSync(join(root, "repo", "packages", "app"), { recursive: true });
  mkdirSync(join(root, "plugin-skills", "lint"), { recursive: true });
  mkdirSync(join(root, "plugin"));
  symlinkSync(join(root, "plugin-skills"), join(root, "plugin", "skills"));
  write(
    "config/plugins/installed_plugins.json",
    JSON.stringify({
      version: 2,
      plugins: {
        "review@local": [
          { scope: "user", installPath: join(root, "cache/local/review/1.0") },
        ],
      },
    }),
  );
  write(
    "config/plugins/known_marketplaces.json",
    JSON.stringify({
      local: {
        source: { source: "directory", path: join(root, "marketplace") },
        installLocation: join(root, "marketplace"),
      },
    }),
  );
  write(
    "cache/local/review/1.0/.claude-plugin/plugin.json",
    JSON.stringify({
      name: "review",
      skills: ["./extra-skills", "./direct"],
      commands: {
        ship: { source: "./custom/ship.md" },
        hello: { content: "Say hello" },
      },
    }),
  );
  revision = () =>
    claudeSetupRevision({
      cwd: join(root, "repo", "packages", "app"),
      env: { CLAUDE_CONFIG_DIR: join(root, "config") },
      pluginPaths: [join(root, "plugin")],
    });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it("stays the same while nothing changes", async () => {
  const first = await revision();
  expect(first).toEqual(expect.any(String));
  expect(await revision()).toBe(first);
});

it.each([
  ["a user skill is added", "config/skills/review/SKILL.md"],
  ["a nested user skill is added", "config/skills/synced/bucket/pdf/SKILL.md"],
  ["a user agent is added", "config/agents/reviewer.md"],
  ["a command is added in a parent's .claude", "repo/.claude/commands/ship.md"],
  ["the project settings change", "repo/packages/app/.claude/settings.json"],
  ["the plugins installed change", "config/plugins/installed_plugins.json"],
  ["a skill behind a plugin's symlink is added", "plugin-skills/lint/SKILL.md"],
  [
    "an installed plugin's skill is added",
    "cache/local/review/1.0/skills/triage/SKILL.md",
  ],
  [
    "an installed plugin's agent is added",
    "cache/local/review/1.0/agents/critic.md",
  ],
  [
    "a skill on an installed plugin's own path is added",
    "cache/local/review/1.0/extra-skills/deep/SKILL.md",
  ],
  [
    "a skill an installed plugin's own path names directly is added",
    "cache/local/review/1.0/direct/SKILL.md",
  ],
  [
    "a command an installed plugin maps to a file outside commands/ is added",
    "cache/local/review/1.0/custom/ship.md",
  ],
  [
    "an installed plugin's MCP servers change",
    "cache/local/review/1.0/.mcp.json",
  ],
  [
    "a known marketplace's manifest changes",
    "marketplace/.claude-plugin/marketplace.json",
  ],
])("changes when %s", async (_case, file) => {
  const before = await revision();
  write(file, "v1");
  const added = await revision();
  expect(added).not.toBe(before);
  write(file, "v2 is longer");
  const edited = await revision();
  expect(edited).not.toBe(added);
  rmSync(join(root, file));
  expect(await revision()).not.toBe(edited);
});

it("reads only each skill's SKILL.md, so a skill's own files neither count nor hide later changes", async () => {
  write("config/skills/big/SKILL.md", "big");
  for (let n = 0; n < 4200; n++) {
    write(`config/skills/big/references/${n}.md`, "reference");
  }
  write("config/skills/big/.git/HEAD", "ref");
  const before = await revision();
  expect(before).toEqual(expect.any(String));
  write("config/skills/big/references/0.md", "edited reference");
  expect(await revision()).toBe(before);
  write("config/agents/reviewer.md", "v1");
  expect(await revision()).not.toBe(before);
});

it("has no revision when the inventory is too large to read whole", async () => {
  for (let n = 0; n < 4200; n++) {
    write(`config/commands/many/${n}.md`, "command");
  }
  expect(await revision()).toBeNull();
});

it("has no revision when the inventory is nested too deep to read whole", async () => {
  write(`config/commands/${"nested/".repeat(9)}deep.md`, "command");
  expect(await revision()).toBeNull();
});
