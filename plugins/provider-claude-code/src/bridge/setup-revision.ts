import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const MAX_DEPTH = 8;
const MAX_ENTRIES = 4096;
const SKIPPED_NAMES = new Set(["node_modules"]);
const PLUGIN_FILES = [
  join(".claude-plugin", "plugin.json"),
  join("hooks", "hooks.json"),
  ".mcp.json",
];

const pathListSchema = z.union([
  z.string().transform((path) => [path]),
  z.array(z.string()),
]);
const pathsSchema = pathListSchema.optional().catch(undefined);
// Commands may also map each name to its source file, or to inline content
// that the fingerprinted manifest already holds.
const commandPathsSchema = z
  .union([
    pathListSchema,
    z
      .record(z.string(), z.object({ source: z.string().optional() }))
      .transform((commands) =>
        Object.values(commands).flatMap(({ source }) =>
          source === undefined ? [] : [source],
        ),
      ),
  ])
  .optional()
  .catch(undefined);
const pluginManifestSchema = z.object({
  skills: pathsSchema,
  agents: pathsSchema,
  commands: commandPathsSchema,
});
const installedPluginsSchema = z.object({
  plugins: z.record(z.string(), z.unknown()),
});
const pluginInstallSchema = z.object({ installPath: z.string() });
const knownMarketplaceSchema = z.object({ installLocation: z.string() });

export interface ClaudeSetupRevisionArgs {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginPaths: readonly string[];
}

export async function claudeSetupRevision(
  args: ClaudeSetupRevisionArgs,
): Promise<string | null> {
  const configDir =
    args.env.CLAUDE_CONFIG_DIR?.trim() ||
    join(args.env.HOME?.trim() || homedir(), ".claude");
  const fingerprint = new SetupFingerprint();
  await fingerprint.file(join(configDir, "settings.json"));
  await fingerprint.inventory(configDir);
  for (let dir = args.cwd; ; dir = dirname(dir)) {
    const claudeDir = join(dir, ".claude");
    await fingerprint.file(join(claudeDir, "settings.json"));
    await fingerprint.file(join(claudeDir, "settings.local.json"));
    await fingerprint.inventory(claudeDir);
    if (dirname(dir) === dir) break;
  }
  const installed = join(configDir, "plugins", "installed_plugins.json");
  const marketplaces = join(configDir, "plugins", "known_marketplaces.json");
  await fingerprint.file(installed);
  await fingerprint.file(marketplaces);
  for (const location of await marketplaceLocations(marketplaces)) {
    await fingerprint.file(
      join(location, ".claude-plugin", "marketplace.json"),
    );
  }
  const pluginPaths = [...(await installPaths(installed)), ...args.pluginPaths];
  for (const path of pluginPaths) await fingerprint.plugin(path);
  return fingerprint.digest();
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function installPaths(registry: string): Promise<string[]> {
  const parsed = installedPluginsSchema.safeParse(await readJson(registry));
  if (!parsed.success) return [];
  return Object.values(parsed.data.plugins).flatMap((entry) =>
    (Array.isArray(entry) ? entry : [entry]).flatMap((install) => {
      const parsedInstall = pluginInstallSchema.safeParse(install);
      return parsedInstall.success ? [parsedInstall.data.installPath] : [];
    }),
  );
}

async function marketplaceLocations(registry: string): Promise<string[]> {
  const value = await readJson(registry);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((entry) => {
    const parsed = knownMarketplaceSchema.safeParse(entry);
    return parsed.success ? [parsed.data.installLocation] : [];
  });
}

class SetupFingerprint {
  private readonly lines: string[] = [];
  private entries = 0;
  private truncated = false;

  async file(path: string): Promise<void> {
    const info = await this.stat(path);
    this.lines.push(
      info?.isFile() ? `${path}\0${info.mtimeMs}\0${info.size}` : `${path}\0-`,
    );
  }

  async inventory(root: string): Promise<void> {
    await this.skills(join(root, "skills"));
    await this.markdown(join(root, "agents"));
    await this.markdown(join(root, "commands"));
  }

  async plugin(root: string): Promise<void> {
    for (const file of PLUGIN_FILES) await this.file(join(root, file));
    await this.inventory(root);
    const manifest = pluginManifestSchema.safeParse(
      await readJson(join(root, ".claude-plugin", "plugin.json")),
    );
    if (!manifest.success) return;
    const custom = (paths: string[] | undefined) =>
      (paths ?? []).map((path) => resolve(root, path));
    for (const path of custom(manifest.data.skills)) await this.skill(path);
    for (const path of custom(manifest.data.agents)) await this.markdown(path);
    for (const path of custom(manifest.data.commands)) {
      await this.markdown(path);
    }
  }

  digest(): string | null {
    if (this.truncated) return null;
    return createHash("sha256").update(this.lines.join("\n")).digest("hex");
  }

  // A directory with a SKILL.md is one skill; any other holds skills.
  private async skill(dir: string, depth = 0): Promise<void> {
    const skill = join(dir, "SKILL.md");
    const info = await this.stat(skill);
    if (info?.isFile()) this.record(skill, info);
    else await this.skills(dir, depth);
  }

  private async skills(dir: string, depth = 0): Promise<void> {
    for (const name of await this.children(dir, depth)) {
      const path = join(dir, name);
      const info = await this.stat(path);
      if (info?.isDirectory()) await this.skill(path, depth + 1);
    }
  }

  private async markdown(path: string, depth = 0): Promise<void> {
    const info = await this.stat(path);
    if (info?.isFile()) {
      if (path.endsWith(".md")) this.record(path, info);
      return;
    }
    if (!info?.isDirectory()) return;
    for (const name of await this.children(path, depth)) {
      await this.markdown(join(path, name), depth + 1);
    }
  }

  private async children(dir: string, depth: number): Promise<string[]> {
    if (this.truncated) return [];
    const names = (await readdir(dir).catch(() => []))
      .filter((name) => !name.startsWith(".") && !SKIPPED_NAMES.has(name))
      .sort();
    if (names.length > 0 && depth >= MAX_DEPTH) {
      this.truncated = true;
      return [];
    }
    return names;
  }

  private record(path: string, info: Stats): void {
    this.lines.push(`${path}\0${info.mtimeMs}\0${info.size}`);
  }

  private async stat(path: string): Promise<Stats | null> {
    if (this.truncated) return null;
    this.entries += 1;
    if (this.entries > MAX_ENTRIES) {
      this.truncated = true;
      return null;
    }
    return stat(path).catch(() => null);
  }
}
