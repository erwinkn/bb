import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveBbCliOverride,
  runBundledCliCommand,
  type BbAppStartContext,
} from "../src/launcher.js";

function createContext(root: string): BbAppStartContext {
  return {
    appDistDir: join(root, "app/dist"),
    appVersion: "0.0.0-test",
    configFile: join(root, "config.json"),
    daemonBundleDir: join(root, "host-daemon/dist"),
    daemonEntry: join(root, "host-daemon/dist/daemon-bundle.mjs"),
    daemonLockDir: join(root, "daemon.lock.lock"),
    daemonLockFile: join(root, "daemon.lock"),
    daemonPort: 39887,
    dataDir: root,
    dbPath: join(root, "bb.db"),
    envFile: join(root, "env.json"),
    logDir: join(root, "logs"),
    packageRoot: join(root, "package"),
    serverEntry: join(root, "server/dist/index.js"),
    serverPort: 39886,
    serverUrl: "http://127.0.0.1:39886",
  };
}

function createLauncherLayout(): {
  root: string;
  launcher: string;
  launcherLink: string;
} {
  const root = mkdtempSync(join(tmpdir(), "bb-cli-override-"));
  const launcher = join(root, "lib/dist/bb.js");
  mkdirSync(join(root, "lib/dist"), { recursive: true });
  writeFileSync(launcher, "");
  mkdirSync(join(root, "bin"));
  const launcherLink = join(root, "bin/bb");
  symlinkSync(launcher, launcherLink);
  return { root, launcher, launcherLink };
}

describe("BB_CLI override in the bb launcher", () => {
  it("ignores BB_CLI when it resolves to the running launcher", () => {
    const { launcher, launcherLink } = createLauncherLayout();

    expect(
      resolveBbCliOverride({
        env: { BB_CLI: launcherLink },
        launcherPath: launcher,
      }),
    ).toBeUndefined();
    expect(
      resolveBbCliOverride({
        env: { BB_CLI: launcher },
        launcherPath: launcherLink,
      }),
    ).toBeUndefined();
  });

  it("ignores BB_CLI once a launcher already followed it", () => {
    expect(
      resolveBbCliOverride({
        env: { BB_CLI: process.execPath, BB_CLI_REEXEC: "1" },
      }),
    ).toBeUndefined();
  });

  it("follows BB_CLI to another CLI", () => {
    const { launcher } = createLauncherLayout();

    expect(
      resolveBbCliOverride({
        env: { BB_CLI: process.execPath },
        launcherPath: launcher,
      }),
    ).toBe(process.execPath);
  });

  it("runs the bundled CLI instead of spawning itself again", async () => {
    const { root, launcher, launcherLink } = createLauncherLayout();
    const context = createContext(root);
    mkdirSync(context.daemonBundleDir, { recursive: true });
    const bundledCli = join(context.daemonBundleDir, "bb");
    writeFileSync(bundledCli, '#!/bin/sh\nprintf bundled > "$1"\n');
    chmodSync(bundledCli, 0o755);
    const outputPath = join(root, "ran.txt");

    const exitCode = await runBundledCliCommand({
      args: [outputPath],
      context,
      env: { BB_CLI: launcherLink, PATH: process.env.PATH },
      launcherPath: launcher,
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe("bundled");
  });

  it("marks the followed BB_CLI so it does not follow BB_CLI again", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-cli-override-"));
    const outputPath = join(root, "reexec.txt");

    const exitCode = await runBundledCliCommand({
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.env.BB_CLI_REEXEC ?? 'missing')",
        outputPath,
      ],
      context: createContext(root),
      env: { BB_CLI: process.execPath },
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe("1");
  });
});
