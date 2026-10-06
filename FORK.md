# Erwin's BB fork

This clone builds `bb-app` from source so the live BB can run patched code.

- Remotes: `origin` is the fork (`github.com/erwinkn/bb`), `upstream` is
  `get-bb/bb`.
- Branch `erwin` is an upstream release tag plus our commits. Today that is
  `desktop-v0.45.0` plus the commits listed under [Patches](#patches).
- Upstream tags each release as `desktop-vX.Y.Z`. The same commit is the npm
  `bb-app@X.Y.Z` release. Upstream also moves a `desktop-latest` tag, so name
  builds with `git describe --tags --match 'desktop-v*'`.

Build output goes to `.fork-build/`, which is listed in `.git/info/exclude`
(local only, never committed).

## Patches

Each patch is one commit on `erwin`, so a rebase conflict names the patch it
belongs to.

| Commit                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add FORK.md, FORK.md: back up the live database with VACUUM INTO    | This runbook.                                                                                                                                                                                                                                                                                                                                                                                 |
| Show message timestamps in the thread view                          | Each user message, and the first assistant reply of each turn, shows a quiet time in its action row: `14:32` today, `Yesterday 14:32`, `Sep 28, 14:32` this year, with the year added for older messages. Hovering shows the full date and time. The time is the row's existing `startedAt`, so there is no server change. Hover actions appear beside it. UI-only: `apps/app/.../timeline/`. |
| bb-app: start the server from the install the launch path points to | The launcher re-resolves its install on every server start. With the `current` symlink below, repointing `current` and killing only the server switches the server and web UI to the new build while the host daemon and agents keep running. Launcher-only: `packages/bb-app/src/launcher.ts`.                                                                                               |

The version stays the upstream one (`0.45.0`). Hosts, plugin `engines` checks
and the Mac self-update all compare versions, and a suffix buys nothing that
the install path does not already show: `~/.bb/bb-app-runtime.json`
records `entryPath`, which names the build directory.

## Build

You need Node ≥ 22.19 and pnpm 9.15.0. Upstream CI builds with Node 24. Node
22.23 builds the same code.

```bash
cd ~/Code/bb
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=bb-app
(cd packages/bb-app && npm pack --pack-destination ../../.fork-build)
```

That is the same build the publish workflow runs (`publish-bb-app.yml`).
`bb-app#build` depends on the web app, server, host daemon, CLI, SDK, plugin
SDK and bundled plugins, and `npm pack` runs the `prepack` chunk pruner. A cold
build takes about 50 s (53 turbo tasks). A rebuild after a UI-only change
takes about 25 s.

Output: `.fork-build/bb-app-<version>.tgz`, about 27 MB packed with 2424
files. 0.44 made the bundled plugins 75% smaller.

Never build a second checkout under `/tmp`. `/tmp` is a RAM-backed tmpfs, and
pnpm cannot hardlink from the store at `~/.local/share/pnpm/store` across
filesystems. It copies every package instead, which filled 100 GB of `/tmp` in
a minute on 2026-10-06. Put extra worktrees under `.fork-build/`.

Release smoke test. Upstream runs it before every publish. Run it under a
scrubbed environment so it cannot see the live BB's `BB_*` variables:

```bash
S=/tmp/bb-smoke-home; mkdir -p $S
cd ~/Code/bb/packages/bb-app && env -i HOME=$S USER=$USER PATH=/usr/local/bin:/usr/bin:/bin \
  npm_config_cache=$HOME/.npm BB_TELEMETRY=false node scripts/smoke-tarball.mjs
```

Run unit tests the same way. With the live `BB_SERVER_URL` exported, four
`bb-app` launcher tests fail because they reach the live server.

```bash
cd ~/Code/bb/packages/bb-app && env -i HOME=/tmp/bb-vitest-home USER=$USER \
  PATH=/usr/local/bin:/usr/bin:/bin ./node_modules/.bin/vitest run --config vitest.config.ts
```

## How close the fork build is to npm

0.43.1 built byte-identical to npm. 0.45.0 does not, for one benign reason: a
zod locale stub embeds the absolute build path in a comment
(`/home/runner/work/bb/bb/...` on CI, `/home/erwin/Code/bb/...` here). That
comment changes the content hash, and therefore the name, of about 80 CLI
chunks. Once build paths and chunk-hash names are normalized:

| Comparison (outside `app/dist`)                    | Result                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm 0.45.0 vs. an unpatched local build of the tag | Server, host daemon (`daemon-bundle.mjs`) and bundled plugins identical. Only CLI chunk names and the member order of a few unions in `dist/index.d.ts` differ         |
| unpatched local vs. the fork build                 | Only the launcher entry bundles (`dist/bb-app.js`, `bb.js`, `bb-server.js`, `bb-host-daemon.js`) and `dist/index.d.ts` differ. Server and daemon bundles are identical |

`app/dist` differs wherever the timestamp patch changes a chunk, and through
it most hashed asset names.

To repeat the comparison:

```bash
V=0.45.0; W=~/Code/bb/.fork-build/compare-$V; rm -rf $W; mkdir -p $W/off $W/fork
(cd $W && npm pack bb-app@$V --silent)
tar -xzf $W/bb-app-$V.tgz -C $W/off; tar -xzf ~/Code/bb/.fork-build/bb-app-$V.tgz -C $W/fork
H='(chunk|browser|cli-error-output|command-resolution|json-shapes)-[A-Z0-9]{8}'
norm() { (cd $1/package && find . -type f ! -path './app/dist/*' | while read -r f; do
  echo "$(echo "$f" | sed -E "s#$H#\1-H#g") $(sed -E "s#/home/runner/work/bb/bb#ROOT#g; s#$HOME/Code/bb#ROOT#g; \
  s#\.bundled-stage-[A-Za-z0-9]{6}#.bundled-stage-X#g; s#\"artifactDigest\": \"[0-9a-f]{64}\"#\"artifactDigest\": \"D\"#; \
  s#$H#\1-H#g" "$f" | sha256sum | cut -c1-16)"; done | LC_ALL=C sort); }
LC_ALL=C comm -3 <(norm $W/off) <(norm $W/fork)       # lists what differs
```

## Install layout

```
~/.local/share/bb-fork/
├── desktop-v0.43.1-1-ged171ddeb/     one npm prefix per build, never modified
├── desktop-v0.45.0-4-gaae33ae3f/
└── current -> desktop-v0.45.0-4-gaae33ae3f
```

The systemd drop-in `~/.config/systemd/user/bb-app.service.d/fork.conf`
starts `current/bin/bb-app` and never changes again:

```ini
[Service]
ExecStart=
ExecStart=/home/erwin/.local/share/bb-fork/current/bin/bb-app start
Environment=PATH=/home/erwin/.local/share/bb-fork/current/bin:/home/erwin/.npm-global/bin:/home/erwin/.local/bin:/usr/local/bin:/usr/bin:/bin
```

Deploying a build means installing it into its own prefix and pointing
`current` at it (`ln -sfn` is atomic). What happens next depends on what
changed:

| Change                                                                                       | Restart                                 | Agents         |
| -------------------------------------------------------------------------------------------- | --------------------------------------- | -------------- |
| UI or server only: same upstream base, and `host-daemon/dist/daemon-bundle.mjs` is identical | the server alone, which takes about 3 s | keep running   |
| Anything else: new upstream version, host protocol, daemon, launcher                         | the whole service, from outside BB      | all turns stop |

Why the server alone is enough: `bb-app start` is a supervisor with two
children, the server and the host daemon. Agents run under the daemon. When
the server exits, the supervisor starts it again, and since the launcher patch
it starts the build that `current` points to. The daemon keeps its process and
reconnects in about 3 s.

The launcher patch only works once the running launcher contains it. The
first switch to a patched 0.45.0 build is always a full restart.

Example: deploy a UI tweak.

```bash
cd ~/Code/bb && pnpm exec turbo run build --filter=bb-app
rm -f .fork-build/bb-app-*.tgz && (cd packages/bb-app && npm pack --pack-destination ../../.fork-build)
B=~/.local/share/bb-fork; NEW=$(git describe --tags --match 'desktop-v*' --dirty)
npm install -g --prefix "$B/$NEW" ~/Code/bb/.fork-build/bb-app-*.tgz
cmp "$B/current/lib/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs" \
    "$B/$NEW/lib/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs" && echo "server-only deploy OK"
PREV=$(readlink "$B/current"); ln -sfn "$NEW" "$B/current"
MAIN=$(systemctl --user show -p MainPID --value bb-app.service)
pkill -TERM -P "$MAIN" -f 'bb-app/server/dist/index.js'      # the supervisor restarts it from $NEW
until curl -sf http://127.0.0.1:38886/health >/dev/null; do sleep 0.5; done
pgrep -af 'bb-app/server/dist/index.js'                        # path now under $NEW
```

The server restart is safe to run from a BB thread: it kills only the server
process, and the thread's own processes run under the daemon. Open browser tabs keep the old UI until
they reload. Undo with `ln -sfn "$PREV" "$B/current"` and the same `pkill`.

Tested on 2026-10-06 in the isolated instance, in both directions between the
patched build and npm 0.45.0. The server PID changed, the daemon PID stayed
the same, the daemon reconnected, the UI gained and lost timestamps, and all
27 running plugins stayed up. Not tested: whether a turn in progress survives
a server-only restart, because the test instance has no providers.

Example: a full restart, e.g. for a new upstream version.

```bash
ln -sfn "$NEW" ~/.local/share/bb-fork/current
systemd-run --user --collect --on-active=15 systemctl --user restart bb-app.service
```

**Restart from outside BB.** Every agent process lives in the
`bb-app.service` cgroup, including the shell of the agent that would run the
restart. `systemctl --user restart bb-app.service` kills all running turns,
including the thread that typed it. Either run it from an SSH terminal or
schedule it as a transient unit, as above. Swap when no turns are running.

Never add `--in-app-updates` to the unit. Since 0.45.0, that flag makes
`bb-app` a shim that runs the newest of its own package and any version
installed from Settings → Updates. A click in Settings would then move the
service onto upstream npm. Without the flag (our unit), Settings cannot
replace the fork.

## Test a build in isolation, on a copy of real data

The isolated instance uses a fake `HOME`, its own data dir and ports
48886/48887, and has telemetry off. Use `env -i`, because a BB agent shell
exports `BB_SERVER_URL=http://127.0.0.1:38886`. Without `env -i`, the test's
`bb` CLI would talk to the live server.

```bash
T=/tmp/bb-fork-test; mkdir -p $T/home $T/data $T/src
cat > $T/env.sh <<EOF
exec env -i HOME=$T/home USER=$USER LANG=C.UTF-8 TERM=dumb TZ=Europe/Paris \\
  PATH=$T/fork/current/bin:/usr/local/bin:/usr/bin:/bin \\
  XDG_CONFIG_HOME=$T/home/.config XDG_DATA_HOME=$T/home/.local/share XDG_CACHE_HOME=$T/home/.cache \\
  BB_DATA_DIR=$T/data BB_SERVER_PORT=48886 BB_HOST_DAEMON_PORT=48887 BB_TELEMETRY=false \\
  BB_SERVER_URL=http://127.0.0.1:48886 npm_config_cache=$HOME/.npm "\$@"
EOF
chmod +x $T/env.sh
$T/env.sh npm install -g --prefix $T/fork/build ~/Code/bb/.fork-build/bb-app-0.45.0.tgz
ln -sfn build $T/fork/current
```

Copy the real data. `VACUUM INTO` takes one consistent snapshot of the live
database in about 5 s (3.0 GB). `.backup` restarts whenever BB writes, so it
never finishes. Copy only the core database and the plugin databases you need.
Do not copy `host-id`: without it the test daemon registers as a new host, so
it never acts on the live host's worktrees.

```bash
sqlite3 ~/.bb/bb.db "VACUUM INTO '$T/data/bb.db'"
for p in initiatives advisor plans questions; do      # no secrets/ dirs, no credentials
  mkdir -p $T/data/plugins/$p; sqlite3 ~/.bb/plugins/$p/data.db "VACUUM INTO '$T/data/plugins/$p/data.db'"
done
```

Before the first start, sanitize the copy. It holds live credentials that
would act on the outside world: the Connect tunnel credential would take over
`erwin.getbb.app`, the push subscription would notify your phone, and the
Account Pooler's OAuth accounts could rotate refresh tokens from under the
live instance. Then point every plugin at copies, because a path plugin's
frontend is rebuilt into its source directory and builtin roots point into
the live install.

```bash
cp -a ~/Code/bb-plugins/plugins $T/src/                 # 2.9 GB; dist/ is rebuilt here, not in the repo
cp -a ~/Code/erwinkn.com-main/packages $T/src/erwinkn-packages   # Threads plugin neighbours, see below
LIVE=$(readlink -f ~/.local/share/bb-fork/current)       # the live build's prefix
sqlite3 $T/data/bb.db <<SQL
DELETE FROM plugin_kv WHERE plugin_id IN ('connect','push-notifications','account-pool','account-pool-local','executor');
UPDATE plugins SET enabled=0 WHERE id IN ('connect','push-notifications','provider-codex','provider-claude-code',
  'provider-pi','provider-acp','automations','scheduled-send','provider-retry','account-pool');
UPDATE plugins SET source=replace(source,'$HOME/Code/bb-plugins/plugins/','$T/src/plugins/'),
  root_dir=replace(root_dir,'$HOME/Code/bb-plugins/plugins/','$T/src/plugins/'),
  source_path=replace(source_path,'$HOME/Code/bb-plugins/plugins/','$T/src/plugins/') WHERE source_kind='path';
UPDATE plugins SET root_dir=replace(root_dir,'$LIVE/','$T/fork/build/') WHERE source_kind='builtin';
SQL
sqlite3 $T/data/bb.db "select id, root_dir from plugins where root_dir like '$HOME/%'"   # must print nothing
```

The Threads plugin lives in `~/Code/erwinkn.com-main/apps/threads/bb-plugin`
and needs its monorepo neighbours. Copy `apps/threads` and `packages/` with
the same relative layout and rewrite its row the same way.

Start, check, stop:

```bash
setsid nohup $T/env.sh $T/fork/current/bin/bb-app start > $T/bb-app.log 2>&1 < /dev/null &
curl -s http://127.0.0.1:48886/health                    # {"ok":true,...}
curl -s http://127.0.0.1:48886/install/version           # {"version":"0.45.0","protocolVersion":227}
$T/env.sh bb connect status                              # "disabled" or "Not paired"
$T/env.sh bb plugin list
$T/env.sh bb-app stop && rm -rf $T
```

For screenshots, `agent-browser` needs `--args "--no-sandbox"` on this host.
Headless Chrome reports `hover: none`, so hover-revealed controls stay hidden.
Force them visible with an injected style when a screenshot needs them.

### Result for 0.45.0 (2026-10-06)

- **Migrations.** The copy went from 119 to 138 migrations (19 new). The
  server answered `/health` 2.0 s after start; the slowest statement was a new
  `events` index at 0.63 s. The server log had no warnings or errors.
- **Timestamps** showed on real threads in light and dark, at 1440 px and
  390 px: `9:12 PM`, `Yesterday 2:07 PM`, `Sep 28, 10:58 AM`, with the full
  date in the tooltip. Screenshots are in `.fork-build/evidence-0.45.0/`.
- **Plugins.** All 16 path plugins loaded. 13 ran; `account-pool-local`,
  `github-prs` and `voice-mode` reported `needs-configuration` because the copy
  has no credentials, as on 0.43.1. Agent tools registered with zero handler
  errors (Initiatives 21, Executor 9, Plans 4, Questions 4, GitHub 3, Threads
  1). `bb initiative list` and the Initiatives dashboard showed the real
  ledger.
- **Connect** stayed disabled, with its credential removed.

## Swap the live BB from 0.43.1 to 0.45.0

This is the first switch to the `current` layout and a version change, so it
is a full restart. Back up first, because migrations only move forward.

```bash
B=~/.local/share/bb-fork; NEW=desktop-v0.45.0-4-gaae33ae3f; OLD=desktop-v0.43.1-1-ged171ddeb
TGZ=~/Code/bb/.fork-build/bb-app-0.45.0.tgz
sha256sum $TGZ        # 5ed5d1ae67769808268a48dc93060306fa0ebe0fef5fc3207a313147fd95eb09 (built 2026-10-06)

# 1. Install the build into its own prefix.
npm install -g --prefix "$B/$NEW" "$TGZ"
grep -q resolveFollowedInstallContext "$B/$NEW/lib/node_modules/bb-app/dist/bb-app.js" && echo ok

# 2. Back up the core database and the plugin databases (seconds).
D=~/.bb-backups/$(date +%F-%H%M)-pre-0.45.0; mkdir -p $D
sqlite3 ~/.bb/bb.db "VACUUM INTO '$D/bb.db'"
for f in ~/.bb/plugins/*/data.db; do p=$(basename $(dirname $f)); mkdir -p $D/plugins/$p
  sqlite3 "$f" "VACUUM INTO '$D/plugins/$p/data.db'"; done

# 3. Create current (still the running build) and move the drop-in onto it.
ln -sfn "$OLD" "$B/current"
cat > ~/.config/systemd/user/bb-app.service.d/fork.conf <<EOF
[Service]
ExecStart=
ExecStart=$B/current/bin/bb-app start
Environment=PATH=$B/current/bin:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF
systemctl --user daemon-reload

# 4. Switch and restart the whole service from outside BB, after 15 s.
ln -sfn "$NEW" "$B/current"
systemd-run --user --collect --on-active=15 systemctl --user restart bb-app.service
```

Check the swap:

```bash
systemctl --user status bb-app.service --no-pager | sed -n 1,12p   # ExecStart under bb-fork/current
curl -s http://127.0.0.1:38886/install/version                     # 0.45.0, protocol 227
pgrep -af 'bb-app/server/dist/index.js'                            # path under desktop-v0.45.0-...
bb plugin list | grep -cE '  running'
journalctl --user -u bb-app.service --since -5min | grep -iE 'error|daemon protocol' | head
```

What to expect in the first minutes:

- Each path plugin logs `rebuilding frontend bundle (built with SDK 0.4.87,
running SDK is 0.6.15)` once. The rebuilt `dist/` lands in
  `~/Code/bb-plugins/plugins/*/dist`, which `.gitignore` excludes, so the
  checkout stays clean.
- The new built-in `thread-list` plugin migrates the sidebar preferences
  stored in BB settings. Our `sidebar` plugin keeps rendering the sidebar.
- The two Macs reconnect after updating themselves (next section).

### Roll back to 0.43.1

0.45.0 ran 19 migrations, so 0.43.1 needs the pre-swap database. Changes made
since the backup are lost.

```bash
# From SSH, not a BB thread:
systemctl --user stop bb-app.service
D=~/.bb-backups/<the pre-0.45.0 backup>
cp $D/bb.db ~/.bb/bb.db && rm -f ~/.bb/bb.db-wal ~/.bb/bb.db-shm
for f in $D/plugins/*/data.db; do p=$(basename $(dirname $f)); cp $f ~/.bb/plugins/$p/data.db; rm -f ~/.bb/plugins/$p/data.db-{wal,shm}; done
ln -sfn desktop-v0.43.1-1-ged171ddeb ~/.local/share/bb-fork/current
systemctl --user start bb-app.service
```

0.43.1 rebuilds the plugin frontends again on its first start, because it
rebuilds on any SDK mismatch. The Macs need a manual step: once they have
updated themselves to protocol 227, a 0.43.1 server (207) is older, and their
daemons refuse to downgrade. Reinstall `bb-app@0.43.1` on each Mac.

To leave the fork entirely, delete `fork.conf`, run
`systemctl --user daemon-reload` and restart. The unit then runs
`~/.npm-global/bin/bb-app` (npm 0.43.1). Restore the backup first if the fork
ran newer migrations.

## Upgrade the fork to a new upstream release

```bash
cd ~/Code/bb
git fetch upstream --tags
OLD=desktop-v0.45.0 NEW=desktop-v0.46.0                 # current base and target tag
git branch erwin-on-${OLD#desktop-} erwin               # keep the old stack
git rebase --onto $NEW $OLD erwin                       # replay our commits onto the new tag
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=bb-app
(cd packages/bb-app && npm pack --pack-destination ../../.fork-build)
```

Then:

1. Compare against the official tarball for `$NEW`. Only patched files should
   differ.
2. Run the patched packages' tests and the smoke test.
3. Run the isolated instance on a copy of real data.
4. Back up the databases and do a full restart (a version change always
   changes the daemon).

`erwin-on-0.43.1` holds the stack before the 0.45.0 rebase. The 0.45.0 rebase
replayed cleanly.

## Compatibility

- **Data dir.** Fork and npm share `~/.bb` (DB, plugin data, secrets, Connect
  pairing). Migrations only move forward, and an older build has no guard
  against a newer database. Back up before every version change.
- **Host protocol: 207 → 227.** The server accepts only an exact protocol
  match. Both Macs (`Erwin's MacBook Pro`, `Erwin's Brimstone MacBook`)
  connect through Connect at protocol 207 today. After the swap, the server
  refuses them. Each daemon then fetches `/install/version`, sees 227 > 207,
  downloads this server's `/install/bb-app.tgz` (the fork package) and
  restarts. Their threads are unavailable until that finishes; if it fails,
  they stay offline until `bb-app@0.45.0` is installed on the Mac by hand. The
  update needs HTTPS, which the Connect URL provides.
- **Plugin SDK: 0.4.87 → 0.6.15.** All our plugins load and run. Against the
  0.6.15 types, five fail `npm run typecheck` (details in the next section).
  All but one failure are type-only, because 0.45.0 keeps the old APIs at
  runtime and detects schemas by duck typing. The exception is the sidebar's
  error fallback.
- **BB Connect.** The pairing credential lives in `plugin_kv` and survives the
  migrations. 0.44.0 fixed Connect tunnel resets. The relay is upstream's
  service, so a fork that falls far behind could eventually meet a relay that
  expects a newer client.
- **Desktop and mobile apps.** Through Connect they load this server's web UI
  and API, so they show the fork's UI, timestamps included. The changelog
  through 0.44.0 names no minimum server version for clients. 0.43.3 added
  saved servers to the desktop app; 0.44.0 added desktop find and zoom and
  mobile keyboard and sidebar fixes. 0.45.0 shipped without changelog notes.
- **In-app updates** are opt-in (`--in-app-updates`). See Install layout.
- **Update badge.** Settings compares against npm `latest`. `npx bb-app@latest`
  and `npm i -g bb-app` update the npm install only; the drop-in keeps the
  service on the fork.

### Plugin type changes under SDK 0.6.15

`npm run typecheck` with `@get-bb/plugin-sdk@0.6.15` installed into copies of
the plugins (all pass on 0.4.87):

| Plugin                                                                                                                       | Errors | Cause                                                                                                                                                                                                                                                               | Runtime                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account-pool, advisor, bb-mcp, github, machine-load, plans, provider-usage-compact, questions, remove-plugin-ellipsis, theme | 0      |                                                                                                                                                                                                                                                                     |                                                                                                                                                                                                                                                                         |
| initiatives                                                                                                                  | 26     | The SDK's zod (4.6.5) has `validate`/`validateAsync`, which the plugin's zod (4.5.4) lacks, so `registerTool` overloads and `ZodType` slots reject its schemas. `serviceTier` narrowed from `string` to `"default" \| "fast"`. Some tool params now infer `unknown` | fine: the server reads schemas through `safeParse` and `~standard`; all 21 tools registered                                                                                                                                                                             |
| executor, editor                                                                                                             | 1, 2   | Same zod skew. Editor's test fixture also lacks the new `hostLifecycle` field                                                                                                                                                                                       | fine                                                                                                                                                                                                                                                                    |
| sidebar                                                                                                                      | 83     | 79 in test fixtures: `PluginSidebarProject` now requires `href` and `settingsHref`, pull requests need `experimental_autoMerge`, and archive rows need `path`. 4 in sources, including `PluginThreadListProps.Original`, which is gone, and `useComposerView`       | **one real break**: 0.45.0 no longer passes `Original` to thread lists, so the "Cannot load threads." branch (`app.tsx:987`, `<props.Original />`) would crash the slot and show BB's "crashed, reload" placeholder instead of the built-in list. The normal path works |
| voice-mode                                                                                                                   | 17     | `useComposerView`, `ComposerView`, `composer.setText`/`updateText` left the public types (`useComposer`, `composer.replace` replace them). Side-chat scopes changed                                                                                                 | kept at runtime as `@internal` legacy APIs. Not exercised: the copy had no voice credentials                                                                                                                                                                            |

Fix at leisure: drop `<props.Original />` from the sidebar's error branch
(the only runtime issue). `bb plugin types` repins a plugin to the running
SDK. Bumping each plugin's `zod` to ≥ 4.6.5 should clear the zod errors
(untested).

## Risks

- **Restart scope.** A full restart kills every running agent turn (see
  above). A server-only restart does not, but it only applies when the daemon
  bundle is unchanged.
- **Forward-only migrations.** Rolling back across a schema change requires
  restoring the DB backup and loses newer data.
- **Rebase conflicts.** Each upstream release can conflict with our patches.
  The timestamp patch touches three timeline files; the launcher patch touches
  one function in `launcher.ts`. Both are separate commits.
- **Upstream drift.** The fork ships nothing until we rebuild, so it misses
  upstream fixes, including security fixes, until we upgrade.
- **Fork CI.** Never enable or trigger Actions on the fork. Scheduled publishing
  is gated to `get-bb/bb`, but manual `workflow_dispatch` runs work in forks,
  and the publish workflow would try to publish to npm.
