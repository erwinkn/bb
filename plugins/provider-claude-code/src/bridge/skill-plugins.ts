import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ClaudeSkillPluginRoot {
  id: string;
  path: string;
}

interface ClaudePluginManifest {
  $schema: string;
  name: string;
  version: string;
  description: string;
  author: { name: string };
  skills: string;
}

const MANIFEST_SCHEMA = "https://anthropic.com/claude-code/plugin.schema.json";

function pluginDirectoryName(root: ClaudeSkillPluginRoot): string {
  return createHash("sha256")
    .update(`${root.id}\0${root.path}`)
    .digest("hex")
    .slice(0, 16);
}

export const CLAUDE_SKILL_PLUGIN_NAME = "bb-global-skills";

function pluginNameFor(
  root: ClaudeSkillPluginRoot,
  takenBy: ReadonlyMap<string, string>,
): string {
  const directory = pluginDirectoryName(root);
  const owner = takenBy.get(CLAUDE_SKILL_PLUGIN_NAME);
  if (owner === undefined || owner === directory) {
    return CLAUDE_SKILL_PLUGIN_NAME;
  }
  return `${CLAUDE_SKILL_PLUGIN_NAME}-${directory.slice(0, 8)}`;
}

function readFileIfAny(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readLink(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : "";
  } catch {
    return null;
  }
}

export function ensureClaudeSkillPlugin(args: {
  pluginsRoot: string;
  root: ClaudeSkillPluginRoot;
  takenNames?: Map<string, string>;
}): string {
  const directory = pluginDirectoryName(args.root);
  const pluginPath = join(args.pluginsRoot, directory);
  const takenNames = args.takenNames ?? new Map<string, string>();
  const name = pluginNameFor(args.root, takenNames);
  takenNames.set(name, directory);
  mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
  const manifest: ClaudePluginManifest = {
    $schema: MANIFEST_SCHEMA,
    name,
    version: "0.1.0",
    description: `Skills injected by bb (${args.root.id}).`,
    author: { name: "bb" },
    skills: "./skills",
  };
  writeFileSync(
    join(pluginPath, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const skillsLink = join(pluginPath, "skills");
  if (readLink(skillsLink) !== args.root.path) {
    rmSync(skillsLink, { recursive: true, force: true });
    symlinkSync(args.root.path, skillsLink, "dir");
  }
  return pluginPath;
}

/**
 * The injected skill plugin at `pluginPath` without the skills named in
 * `hidden`: a sibling copy whose skills link one by one, or the plugin itself
 * when it hides none. Claude Code's skillOverrides setting only reaches its own
 * skills, not a plugin's.
 */
export function withoutHiddenSkills(
  pluginPath: string,
  hidden: ReadonlySet<string>,
): string {
  const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
  const skillsPath = join(pluginPath, "skills");
  const skills = readdirSync(skillsPath);
  const dropped = skills.filter((skill) => hidden.has(skill));
  if (dropped.length === 0) {
    return pluginPath;
  }
  const filteredPath = `${pluginPath}-${createHash("sha256")
    .update(dropped.sort().join("\0"))
    .digest("hex")
    .slice(0, 8)}`;
  const filteredSkillsPath = join(filteredPath, "skills");
  mkdirSync(join(filteredPath, ".claude-plugin"), { recursive: true });
  mkdirSync(filteredSkillsPath, { recursive: true });
  // A session starting from this copy may be reading it: write only what changed.
  const filteredManifestPath = join(filteredPath, ".claude-plugin", "plugin.json");
  if (readFileIfAny(filteredManifestPath) !== readFileSync(manifestPath, "utf8")) {
    copyFileSync(manifestPath, filteredManifestPath);
  }
  const kept = new Map(
    skills
      .filter((skill) => !dropped.includes(skill))
      .map((skill) => [skill, realpathSync(join(skillsPath, skill))]),
  );
  for (const entry of readdirSync(filteredSkillsPath)) {
    if (!kept.has(entry)) {
      rmSync(join(filteredSkillsPath, entry), { recursive: true, force: true });
    }
  }
  for (const [skill, target] of kept) {
    const link = join(filteredSkillsPath, skill);
    if (readLink(link) !== target) {
      rmSync(link, { recursive: true, force: true });
      symlinkSync(target, link, "dir");
    }
  }
  return filteredPath;
}

export function createClaudeSkillPluginsRoot(baseDir = tmpdir()): string {
  mkdirSync(baseDir, { recursive: true });
  return mkdtempSync(join(baseDir, "bb-claude-skill-plugins-"));
}
