# Erwin's BB fork

This clone builds `bb-app` from source so the live BB can run patched code.

- Remotes: `origin` is the fork (`github.com/erwinkn/bb`), `upstream` is
  `get-bb/bb`.
- Branch `erwin` is an upstream release tag plus our commits. Today that is
  `desktop-v0.43.1` plus this file, with no behaviour patches.
- Upstream tags each release as `desktop-vX.Y.Z`. The same commit is the npm
  `bb-app@X.Y.Z` release.

Build output goes to `.fork-build/`, which is listed in `.git/info/exclude`
(local only, never committed).

## Build

You need Node ≥ 22.19 and pnpm 9.15.0. Upstream CI builds with Node 24. Node
22.23 produces the same output.

```bash
cd ~/Code/bb
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=bb-app
(cd packages/bb-app && npm pack --pack-destination ../../.fork-build)
```

That is the same build the publish workflow runs (`publish-bb-app.yml`).
`bb-app#build` depends on the web app, server, host daemon, CLI, SDK, plugin
SDK and bundled plugins, and `npm pack` runs the `prepack` chunk pruner. A cold
build takes about 50 s (48 turbo tasks) and the install takes about 25 s.

Output: `.fork-build/bb-app-<version>.tgz`, about 46 MB packed and 220 MB
unpacked, with 2193 files.

Release smoke test. Upstream runs it before every publish. Run it under a
scrubbed environment so it cannot see the live BB's `BB_*` variables:

```bash
S=/tmp/bb-smoke-home; mkdir -p $S
cd ~/Code/bb/packages/bb-app && env -i HOME=$S USER=$USER PATH=/usr/local/bin:/usr/bin:/bin \
  npm_config_cache=$HOME/.npm BB_TELEMETRY=false node scripts/smoke-tarball.mjs
```

## How close the fork build is to npm

The fork build of 0.43.1 was compared with the official
`npm pack bb-app@0.43.1` tarball and with the live install at
`~/.npm-global/lib/node_modules/bb-app`:

| Check                                                | Result                                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                       | identical                                                                                                                                                                                             |
| File list                                            | identical (2193 files, 219,503,495 bytes in both)                                                                                                                                                     |
| Web UI (`app/dist`, including hashed asset names)    | byte-identical                                                                                                                                                                                        |
| Server, host daemon, CLI, launcher bundles           | byte-identical                                                                                                                                                                                        |
| Bundled plugin set (34 + `marketplace.json`)         | identical                                                                                                                                                                                             |
| Bundled plugin `server.js` / `host.js` (54 files)    | differ only in a comment naming a random staging dir (`.bundled-stage-gBaB8t` vs `.bundled-stage-mrKX3q`) and the `artifactDigest` hash derived from it. They are identical once those are normalized |
| npm dependency tree after `npm install -g <tarball>` | identical (220 packages, same versions)                                                                                                                                                               |
| Live install vs official tarball                     | byte-identical                                                                                                                                                                                        |
| Release-only config baked in at publish              | none. The publish workflow sets no build env. PostHog, Connect and marketplace URLs are in source, so a fork build behaves exactly like npm                                                           |

The `artifactDigest` change has no visible effect. The server checks each host
bundle against its own `host.meta.json`, which is consistent within one build.

Two things can drift over time:

- **Dependencies.** The published package ships no lockfile. Ranges such as
  `hono ^4.7.0` resolve at install time, for npm installs and fork installs
  alike.
- **Tarball bytes.** gzip metadata differs, so compare unpacked trees, never
  tarball hashes.

To repeat the comparison for another version:

```bash
V=0.43.1; W=/tmp/bb-compare; rm -rf $W; mkdir -p $W/off $W/fork $W/dl
(cd $W/dl && npm pack bb-app@$V --silent)
tar -xzf $W/dl/bb-app-$V.tgz -C $W/off; tar -xzf ~/Code/bb/.fork-build/bb-app-$V.tgz -C $W/fork
norm() { (cd $1/package && find . -type f | sort | while read -r f; do printf '%s ' "$f"; \
  sed -E 's/\.bundled-stage-[A-Za-z0-9]{6}/.bundled-stage-X/g; s/"artifactDigest": "[0-9a-f]{64}"/"artifactDigest": "D"/' "$f" | sha256sum; done); }
diff <(norm $W/off) <(norm $W/fork) && echo "identical modulo staging-dir names"
```

With patches, the diff should list only the files the patches touch.

## Test a build in isolation

The isolated instance uses a fake `HOME`, its own data dir and ports
48886/48887, and has telemetry off. Use `env -i`, because a BB agent shell
exports `BB_SERVER_URL=http://127.0.0.1:38886`. Without `env -i`, the test's
`bb` CLI would talk to the live server.

```bash
T=/tmp/bb-fork-test; mkdir -p $T/home $T/prefix $T/data
cat > $T/env.sh <<EOF
exec env -i HOME=$T/home USER=$USER LANG=C.UTF-8 TERM=dumb \\
  PATH=$T/prefix/bin:/usr/local/bin:/usr/bin:/bin \\
  XDG_CONFIG_HOME=$T/home/.config XDG_DATA_HOME=$T/home/.local/share XDG_CACHE_HOME=$T/home/.cache \\
  BB_DATA_DIR=$T/data BB_SERVER_PORT=48886 BB_HOST_DAEMON_PORT=48887 BB_TELEMETRY=false \\
  BB_SERVER_URL=http://127.0.0.1:48886 npm_config_cache=$HOME/.npm "\$@"
EOF
chmod +x $T/env.sh
$T/env.sh npm install -g --prefix $T/prefix ~/Code/bb/.fork-build/bb-app-0.43.1.tgz
setsid nohup $T/env.sh bb-app start > $T/bb-app.log 2>&1 < /dev/null &
curl -s http://127.0.0.1:48886/health        # {"ok":true,...}
$T/env.sh bb connect status                  # must say "Not paired"
$T/env.sh bb plugin list
```

To load our plugins, copy them first: `bb plugin install path:` builds into the
plugin directory, so never point a test instance at `~/Code/bb-plugins`. The
Threads plugin needs its monorepo neighbours (`packages/`,
`apps/threads/{src,node_modules}`).

```bash
mkdir -p $T/plugins && cp -a ~/Code/bb-plugins/plugins/<name> $T/plugins/
$T/env.sh bb plugin install path:$T/plugins/<name> --yes
```

Stop it and clean up:

```bash
$T/env.sh bb-app stop
rm -rf $T
```

### Result for 0.43.1

These checks ran on 2026-10-06:

- The server and daemon came up on 48886/48887, and `/health` returned 200.
- The web UI rendered in headless Chrome, including plugin surfaces (sidebar
  Initiatives, Advisor, GitHub, Spaces, Voice).
- Connect reported "Not paired". The fake home received the provider probes
  (`.codex`, `.claude`).
- All 16 live path plugins installed from copies:
  - 13 ran.
  - `account-pool-local`, `github-prs` and `voice-mode` reported
    `needs-configuration` because the fake home has no credentials.
- The server logged no errors. Its one non-plugin warning (bb-community
  marketplace has more than 256 plugins) also appears on the live 0.43.1, so it
  comes from upstream.
- The live service kept the same PIDs and had zero restarts.

## Swap the live BB to the fork

The live BB is the systemd user unit `bb-app.service`, which runs
`~/.npm-global/bin/bb-app start`. The swap leaves that unit file and the npm
install untouched. It installs the fork into its own versioned prefix and points
the unit at it with a drop-in, so rolling back means deleting one file.

**Restart from outside BB.** Every agent process lives in the
`bb-app.service` cgroup, including the shell of the agent that would run the
restart. `systemctl --user restart bb-app.service` kills all running turns,
including the thread that typed it. Either run the commands from an SSH
terminal or schedule the restart as a separate transient unit (shown below).
Swap when no turns are running.

```bash
# 1. Install the build beside the npm install, one prefix per build.
BUILD=$(git -C ~/Code/bb describe --tags --always)        # e.g. desktop-v0.43.1-1-gabc1234
FORK=$HOME/.local/share/bb-fork/$BUILD
npm install -g --prefix "$FORK" ~/Code/bb/.fork-build/bb-app-0.43.1.tgz
"$FORK/bin/bb-app" --help > /dev/null && echo ok

# 2. Back up the database. This is optional for the same version and required
#    when the build changes version, because migrations are forward-only.
mkdir -p ~/.bb-backups
sqlite3 ~/.bb/bb.db ".backup '$HOME/.bb-backups/bb-$(date +%F-%H%M).db'"

# 3. Point the unit at the fork.
mkdir -p ~/.config/systemd/user/bb-app.service.d
cat > ~/.config/systemd/user/bb-app.service.d/fork.conf <<EOF
[Service]
ExecStart=
ExecStart=$FORK/bin/bb-app start
Environment=PATH=$FORK/bin:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF
systemctl --user daemon-reload
systemctl --user cat bb-app.service | tail -6     # shows the drop-in

# 4. Restart in a transient unit, outside the bb-app cgroup, after 15 s.
systemd-run --user --collect --on-active=15 systemctl --user restart bb-app.service
```

Check the swap:

```bash
systemctl --user status bb-app.service --no-pager | sed -n 1,12p   # ExecStart under bb-fork/
curl -s http://127.0.0.1:38886/health
bb plugin list | grep -c running
```

Inside BB threads, the `bb` CLI follows the running daemon on its own: the
daemon sets `BB_CLI` to its own copy, and every `bb` entrypoint re-execs to it.
Your interactive shells still find `~/.npm-global/bin/bb` and `bb-app`. That is
harmless while the versions match. Put `$FORK/bin` first in your shell `PATH`
once they diverge. `bb-app config` and `bb-app env` edit `~/.bb/*.json` from
either install.

To update the fork, build and install into a new `$FORK` prefix, rewrite
`fork.conf`, then reload and restart. The previous prefix stays on disk, so
going back to the last fork build is another drop-in edit.

### Swap back to npm

```bash
rm ~/.config/systemd/user/bb-app.service.d/fork.conf
systemctl --user daemon-reload
systemd-run --user --collect --on-active=15 systemctl --user restart bb-app.service
```

If the fork ran migrations the npm version does not know, restore the backup
first. Changes made since the backup are lost.

```bash
systemctl --user stop bb-app.service          # from SSH, not a BB thread
cp ~/.bb-backups/<backup>.db ~/.bb/bb.db && rm -f ~/.bb/bb.db-wal ~/.bb/bb.db-shm
systemctl --user start bb-app.service
```

## Upgrade the fork to a new upstream release

```bash
cd ~/Code/bb
git fetch upstream --tags
OLD=desktop-v0.43.1 NEW=desktop-v0.45.0                 # current base and target tag
git branch erwin-on-${OLD#desktop-} erwin               # keep the old stack
git rebase --onto $NEW $OLD erwin                       # replay our commits onto the new tag
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=bb-app
(cd packages/bb-app && npm pack --pack-destination ../../.fork-build)
```

Then:

1. Run the comparison against the official tarball for `$NEW`. Only patched
   files should differ.
2. Run the smoke test.
3. Run the isolated test instance.
4. Back up the database and swap.

Update the base tag named at the top of this file.

Version naming: an unpatched build keeps the upstream version. For patched
builds, `X.Y.Z-erwin.N` in `packages/bb-app/package.json` makes the fork
visible in `bb --version` and Settings. Every app-version check (plugin
`engines.bb`, the plugin update resolver) uses `semver.coerce`, so the suffix
does not break plugin compatibility. Check `.github/workflows/check-version-lockstep.mjs`
before relying on that.

## Compatibility

- **Data dir.** Fork and npm share `~/.bb` (DB, plugins, secrets, Connect
  pairing). The same version means the same schema: on 2026-10-06 the live DB
  had all 119 migrations the 0.43.1 source ships. Migrations only move forward,
  and an older build has no guard against a newer database. Back up before
  every version change.
- **BB Connect** (`erwin.getbb.app`). Pairing lives in the data dir, so the
  tunnel reconnects after the restart like after any restart. The relay is
  upstream's service. If the fork falls far behind, the relay could eventually
  expect a newer client.
- **Other machines.** Two Mac host daemons (`manual`) are joined to this
  server. A host updates itself from this server's `/install/bb-app.tgz` (the
  fork's own package) only when the server's host protocol
  (`HOST_DAEMON_PROTOCOL_VERSION`, 207 in 0.43.1) is higher than its own. A Mac
  running a newer npm bb-app than the fork gets a protocol warning instead. Keep
  the Macs at or below the fork's version.
- **Desktop and mobile apps.** These ship on upstream's schedule. Through
  Connect they load this server's web UI and API, so a fork that trails
  upstream by several releases may meet newer clients that expect APIs it lacks.
- **Plugin SDK.** 0.43.1 reports SDK `0.4.87` (`packages/domain/src/plugin-sdk-version.ts`),
  the version our plugins pin from npm (`@get-bb/plugin-sdk@0.4.87`,
  `engines.bbPluginSdk >=0.4.87`). Patches that leave the plugin API alone need
  no SDK work. If a patch extends the API, build the SDK from
  `packages/plugin-sdk` and point the affected plugins at that tarball. Do not
  bump the SDK version, because plugins would then require a version npm does
  not have.
- **Update badge.** Settings compares against npm `latest` and suggests
  `npx bb-app@latest`. That command, and `npm i -g bb-app`, update the npm
  install only. The drop-in keeps the service on the fork.

## Risks

- **Restart scope.** A restart kills every running agent turn (see above).
- **Forward-only migrations.** Rolling back across a schema change requires
  restoring the DB backup and loses newer data.
- **Rebase conflicts.** Each upstream release can conflict with our patches.
  Keep patches small and few, and keep them in separate commits.
- **Upstream drift.** The fork ships nothing until we rebuild, so it misses
  upstream fixes, including security fixes, until we upgrade.
- **Fork CI.** Never enable or trigger Actions on the fork. Scheduled publishing
  is gated to `get-bb/bb`, but manual `workflow_dispatch` runs work in forks,
  and the publish workflow would try to publish to npm.
