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
import { afterEach, describe, expect, it, vi } from "vitest";
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

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-follow-install-"));
  roots.push(root);
  return root;
}

function writePackage(
  packageRoot: string,
  version: string,
  daemon = "daemon",
  name = "bb-app",
): string {
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(join(packageRoot, "host-daemon", "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "bb-app.js"), "");
  writeFileSync(
    join(packageRoot, "host-daemon", "dist", "daemon-bundle.mjs"),
    daemon,
  );
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name, version }),
  );
  return packageRoot;
}

function installBuild(
  root: string,
  name: string,
  version: string,
  daemon = "daemon",
): string {
  return writePackage(
    join(root, name, "lib", "node_modules", "bb-app"),
    version,
    daemon,
  );
}

function startContext(packageRoot: string) {
  return resolveBbAppStartContext({
    entrypointUrl: pathToFileURL(join(packageRoot, "dist", "bb-app.js")).href,
    env: { BB_DATA_DIR: "/data", BB_SERVER_PORT: "48886" },
    homeDir: "/home/tester",
  });
}

function currentLaunchPath(root: string): string {
  return join(
    root,
    "current",
    "lib",
    "node_modules",
    "bb-app",
    "dist",
    "bb-app.js",
  );
}

describe("resolveFollowedInstallContext", () => {
  it("follows a repointed install with the same host daemon and keeps runtime settings", () => {
    const root = tempRoot();
    const oldRoot = installBuild(root, "old", "0.45.0");
    const newRoot = installBuild(root, "new", "0.45.0");
    symlinkSync("new", join(root, "current"));

    const context = resolveFollowedInstallContext(
      startContext(oldRoot),
      currentLaunchPath(root),
    );

    expect(context.packageRoot).toBe(newRoot);
    expect(context.serverEntry).toBe(
      join(newRoot, "server", "dist", "index.js"),
    );
    expect(context.appDistDir).toBe(join(newRoot, "app", "dist"));
    expect(context.daemonEntry).toBe(
      join(oldRoot, "host-daemon", "dist", "daemon-bundle.mjs"),
    );
    expect(context.dataDir).toBe("/data");
    expect(context.serverPort).toBe(48886);
  });

  it("keeps the running build when the repointed install has a different host daemon", () => {
    const root = tempRoot();
    const oldRoot = installBuild(root, "old", "0.45.0", "protocol 227");
    installBuild(root, "new", "0.46.0", "protocol 228");
    symlinkSync("new", join(root, "current"));
    const context = startContext(oldRoot);
    const warn = vi.fn();

    expect(
      resolveFollowedInstallContext(context, currentLaunchPath(root), warn),
    ).toBe(context);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps the desktop app's own package when a bridge script is the launch path", () => {
    const desktop = tempRoot();
    const packageRoot = writePackage(
      join(desktop, "node_modules", "bb-app"),
      "0.45.0",
    );
    mkdirSync(join(desktop, "dist"), { recursive: true });
    writeFileSync(
      join(desktop, "dist", "bb-app-bridge.mjs"),
      'import "bb-app/dist/bb-app.js";\n',
    );
    const context = startContext(packageRoot);

    expect(
      resolveFollowedInstallContext(
        context,
        join(desktop, "dist", "bb-app-bridge.mjs"),
      ),
    ).toBe(context);
  });

  it("ignores a dist/bb-app.js that does not belong to bb-app", () => {
    const root = tempRoot();
    const packageRoot = installBuild(root, "only", "0.45.0");
    const other = writePackage(
      join(root, "other"),
      "1.0.0",
      "daemon",
      "something-else",
    );
    const context = startContext(packageRoot);

    expect(
      resolveFollowedInstallContext(context, join(other, "dist", "bb-app.js")),
    ).toBe(context);
  });

  it("keeps the launch context when the install has not moved or the path is missing", () => {
    const root = tempRoot();
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
