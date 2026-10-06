import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveBbAppStartContext,
  resolveFollowedInstallContext,
} from "../src/launcher.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function installBuild(root: string, name: string, version: string): string {
  const packageRoot = join(root, name, "lib", "node_modules", "bb-app");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "bb-app.js"), "");
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "bb-app", version }),
  );
  return packageRoot;
}

function startContext(packageRoot: string) {
  return resolveBbAppStartContext({
    entrypointUrl: pathToFileURL(join(packageRoot, "dist", "bb-app.js")).href,
    env: { BB_DATA_DIR: "/data", BB_SERVER_PORT: "48886" },
    homeDir: "/home/tester",
  });
}

describe("resolveFollowedInstallContext", () => {
  it("follows a repointed install for the server and keeps runtime settings", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-follow-install-"));
    roots.push(root);
    const oldRoot = installBuild(root, "old", "0.45.0");
    const newRoot = installBuild(root, "new", "0.45.1");
    symlinkSync("new", join(root, "current"));
    const launchPath = join(
      root,
      "current",
      "lib",
      "node_modules",
      "bb-app",
      "dist",
      "bb-app.js",
    );

    const context = resolveFollowedInstallContext(
      startContext(oldRoot),
      launchPath,
    );

    expect(context.packageRoot).toBe(newRoot);
    expect(context.appVersion).toBe("0.45.1");
    expect(context.serverEntry).toBe(
      join(newRoot, "server", "dist", "index.js"),
    );
    expect(context.daemonEntry).toBe(
      join(oldRoot, "host-daemon", "dist", "daemon-bundle.mjs"),
    );
    expect(context.dataDir).toBe("/data");
    expect(context.serverPort).toBe(48886);
  });

  it("keeps the launch context when the install has not moved", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-follow-install-"));
    roots.push(root);
    const packageRoot = installBuild(root, "only", "0.45.0");
    const context = startContext(packageRoot);

    expect(
      resolveFollowedInstallContext(
        context,
        join(packageRoot, "dist", "bb-app.js"),
      ),
    ).toBe(context);
    expect(
      resolveFollowedInstallContext(context, join(root, "missing.js")),
    ).toBe(context);
  });
});
