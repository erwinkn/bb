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

## Working in the fork

- `~/Code/bb` is the one main checkout. Work there, on branch `erwin`. Put
  extra worktrees under `.fork-build/`, never under `/tmp`.
- `erwin` tracks `origin/erwin` on `github.com/erwinkn/bb`.
- Workers commit locally and never push. The coordinator pushes after a worker
  reports. After a rebase, that push is
  `git push --force-with-lease origin erwin`.
- To move to a new upstream release, rebase `erwin` onto its tag (see
  [Upgrade](#upgrade-the-fork-to-a-new-upstream-release)). Never merge
  upstream into `erwin`; the branch stays "a tag plus our commits".
- Never push to `upstream`, and never open PRs or issues there.
- Agents start from the `bb-fork` skill (`.bb/skills/bb-fork/SKILL.md`),
  which BB loads for threads in this checkout. `.bb/AGENTS.md` points every
  thread here at it. Agents patch, build and check. Only the coordinator
  deploys or rolls back.
- Never run `pnpm`, `npm` or `turbo` under `env -i` or with a fresh `HOME`.
  The checkout pins pnpm 9.15.0 (`packageManager`), so pnpm downloads it into
  that HOME first, and pnpm before 10.33.2 could recurse doing so
  (pnpm/pnpm#11337); that took the machine down on 2026-10-07. The global
  pnpm is now 10.33.2 and still switches to 9.15.0 inside `~/Code/bb`.

## Scripts

`scripts/fork/` runs every procedure in this file; FORK.md explains what they do and why. Each script prints its
usage with `--help`, and every script that changes something accepts
`--dry-run`.

| Command                                               | Who         | What it does                                                                                                                                                                        |
| ----------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/fork/status [--fetch]`                       | anyone      | Read-only: the running server and daemon builds, `current`, the previous build, the drop-in, `erwin` versus upstream and origin, the newest backup                                  |
| `scripts/fork/build`                                  | anyone      | `pnpm install --frozen-lockfile`, `turbo build --filter=bb-app`, `npm pack` into `.fork-build/`                                                                                     |
| `scripts/fork/check [--keep] [--stop]`                | anyone      | The isolated test on a sanitized copy of `~/.bb` (next sections), with a summary and the restart a deploy would need                                                                |
| `scripts/fork/upgrade <tag> [--continue]`             | anyone      | Rebases `erwin` onto an upstream tag, keeps the old stack as `erwin-on-<version>`, builds, checks and summarizes protocol, SDK, migration and changelog changes. Stops on conflicts |
| `scripts/fork/deploy [--full] [--tarball]`            | coordinator | Builds, installs into a new prefix, backs up the databases if the schema or version changes, repoints `current`, and restarts the server alone or the whole service                 |
| `scripts/fork/rollback [--to] [--npm] [--restore-db]` | coordinator | Points `current` back at the previous build (or npm) and restarts. With `--restore-db`, a transient unit stops the service, restores the backup and starts it                       |

`deploy` and `rollback` choose a server-only restart only when the running
launcher has the follow-install patch, the drop-in starts `current`, and the
version, daemon bundle, launcher and migrations are all unchanged. Otherwise
they schedule a full restart 15 s out in a transient unit. That restart also
kills the shell that ran the command when it runs inside BB. 75 s later a
second transient unit writes `scripts/fork/status` to
`~/.local/share/bb-fork/last-deploy-check.txt`.

For tests, `FORK_SERVICE`, `FORK_BUILDS`, `FORK_BACKUPS`, `FORK_LIVE_DATA`,
`FORK_LIVE_URL` and `FORK_NPM_PACKAGE` point the scripts at another unit.
On 2026-10-06 they ran against a throwaway `bb-fork-test.service` on ports
48886/48887:

- first deploy, npm 0.43.1 → fork 0.45.0: full restart and backup
- redeploy: server-only in 8 s, daemon PID unchanged
- `rollback`: server-only toggle back to the previous build
- `rollback --npm`: refused without a backup
- `rollback --npm --restore-db`: back to 0.43.1 with 119 migrations

`upgrade` also ran in a throwaway clone, 0.43.1 stack → 0.45.0. It stopped on
a planted conflict, then `--continue` built and checked in 56 s.

## Patches

Each patch is one commit on `erwin`, so a rebase conflict names the patch it
belongs to.

| Commit                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add FORK.md, FORK.md: back up the live database with VACUUM INTO         | This runbook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Show message timestamps in the thread view                               | Each user message, and the first assistant reply of each turn, shows a quiet time in its action row: `14:32` today, `Yesterday 14:32`, `Sep 28, 14:32` this year, with the year added for older messages. Hovering shows the full date and time. The time is the row's existing `startedAt`, so there is no server change. Hover actions appear beside it. UI-only: `apps/app/.../timeline/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| bb-app: start the server from the install the launch path points to      | The launcher re-resolves its install on every server start. With the `current` symlink below, repointing `current` and killing only the server switches the server and web UI to the new build while the host daemon and agents keep running. Launcher-only: `packages/bb-app/src/launcher.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| bb-app: follow only bb-app's own entrypoint, and only to the same daemon | Fix for the patch above, found by review A287. The launcher follows the launch path only when it resolves to bb-app's own `dist/bb-app.js`, so desktop (bridge script), npm and source launches keep their own paths. It refuses a build whose host daemon differs. Squash into the patch above at the next upgrade.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Queue: send queued messages once a failed turn has settled               | A thread whose turn failed or was interrupted lands in `error`, and BB's queue drain only ever looked at `idle` threads, so messages waiting on `thread-busy` or `turn-starting` stayed queued forever. The idle sweep (every 10 s, and after restarts) now also drains an `error` thread once it has been in error for 60 s, the provider had accepted the failed turn's input, and no retry row is waiting. A failure at the door (rate limit, auth) and plugin retries keep today's behavior. Server-only: `apps/server/.../threads/errored-thread-queue.ts`, `queued-messages.ts`, `packages/db/.../queued-thread-messages.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Reconnect: resume the running turn instead of a turnless active thread   | When a daemon reconnects and reports a thread as still running, BB used to flip an `error` or `idle` thread back to `active` even when it had already closed that thread's turn as interrupted, leaving it active with no turn: queued messages waited on `turn-starting` and the thread looked busy until the agent ended on its own. Now an open turn is revived as before; a turn BB itself closed during the outage (the thread's last events are BB's host interruption of its latest turn, and the same daemon instance is back) is re-adopted by retracting those rows (`history-rewritten`), so the provider's real completion settles the turn and wakes the queue; a pending turn request revives as before; anything else stays settled. Server-only: `apps/server/.../threads/reconnect-turn-adoption.ts`, `thread-lifecycle.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Timeline: paint the visible rows first, mount the overscan after         | A windowed timeline mounts the visible rows with an overscan of 1 and widens it to 8 in the frame after the first paint, so a thread switch lays out 7-9 rows instead of 10-16 before anything shows. First row 13-17% sooner and longest task 8-15% shorter on warm switches (T127). UI-only: `apps/app/.../timeline/TimelineWindowedItems.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Plugin navigation: open a thread without waiting for a fetch             | The plugin SDK's `navigate.toThread` takes the project from cached thread data (thread, thread lists, sidebar navigation) instead of fetching `/threads/<id>` first; when nothing is cached it fetches through the thread query, so the view does not fetch again. Removes one round trip before every switch from a plugin (about 200 ms over bb connect) and the duplicate fetch. UI-only: `apps/app/.../hooks/queries/thread-queries.ts`, `lib/plugin-sdk-hooks.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Timeline: extend the ordering context instead of rebuilding it           | The timeline ordering context keeps its rows per thread and reads only the rows after the cached maximum; a rewrite (generation) or another connection's write (data_version) still rebuilds. On Coffre PM a build after a new turn spends 9-14 ms there instead of 25-35 ms warm, about 300 ms cold. Server-only: `apps/server/.../threads/timeline-context-order.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Stall monitor: say what blocked the event loop                           | Each "Event loop stalled" line gets an "Event loop stall attributed" line (DB time by work label, slowest statement, GC pauses), and a worker profiles the main thread through the inspector while a stall lasts ("Event loop stall sampled": heaviest functions and stack). Server-only: `apps/server/.../system/event-loop-stall-*.ts`, `packages/db/src/connection.ts` (optional `onQuery` hook; the host daemon does not use `@bb/db`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SDK: link request timeouts with a listener instead of AbortSignal.any    | Every `bb.sdk` call that passed a signal built `AbortSignal.any([signal, AbortSignal.timeout(75 s)])`. Node 22 records that composite on the caller's signal for 75 s, even after a 5 ms call, and GC finalization walks every recorded composite; on a plugin's lifetime signal that froze the server for 1-9 s (T137). Each request now owns one `AbortController`, linked to the caller's signal by an abort listener and to an unref'd timer, and both are removed once the underlying body ends (fully read, cancelled or errored) or the request fails. Release follows the body stream, not reader promises: a second `text()` that fails with "body used" leaves the first read abortable (review W199). Streaming bodies keep the link until they end. Abort reasons and `BbRequestTimeoutError` are unchanged; `readVoidResponse` now reads the body so void calls release at once. 20,000 calls on one signal leave 0 recorded composites instead of 25,000. This also covers `concurrency-limit` passing its service signal to `hosts.list`. Server-only: `packages/sdk/src/response.ts`, tests in `packages/sdk/test/`.                                                                                                                                                                              |
| Plugins: name the slowest handler and warn on handlers over 5 s          | Handler stats record the call that set the max (its label, such as `cli recreate-coordinators` or `rpc sync`, and when it started), and `bb plugin list` prints `66.5s max (cli recreate-coordinators, 01:31)`, with the date when it is not today. A handler that takes 5 s or more logs a `Slow plugin handler` warning with `pluginId`, `handler` and `durationMs`, at most once per plugin and handler every 10 s; the rest are counted and reported as one `Slow plugin handler calls suppressed` line with the count and max duration (`slow-handler-log.ts`). `maxCall` is optional in `pluginHandlerStatsSchema`. Server-only: `apps/server/.../plugins/plugin-runtime.ts`, `packages/server-contract/src/api/plugins.ts`, `apps/cli/src/commands/plugin.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Connect tunnel: log slow forwarded requests and relay cancellations      | The tunnel client logged only initial thread loads. It now logs one warning per forwarded HTTP request that takes 5 s or more (`bb connect slow request`) and per request the relay cancels with `close-stream` (`bb connect request cancelled by relay`): method, path without query, status, origin time to first byte, total time, and the relay's reason. A response head after 30 s adds `relayTimedOut=true`, because the relay has already sent the visitor a 504 and does not tell the client. Each kind, method and path logs at most once every 10 s; the rest are counted and reported as one `suppressed=N maxTotalMs=…` line when the window ends or the session closes. Paths are cut at `?` with string operations, and logging never throws, so a path such as `//[bad` cannot cause an unhandled rejection (review W199); the upstream `origin http error` and `thread load` lines use the same helper, so they no longer print query strings either. Query strings and bodies are never logged, and the Cloudflare relay is unchanged. Files: `packages/tunnel-client/src/session.ts`, `request-log.ts`. **Full restart**: `packages/tunnel-client/src/session.ts` is also bundled into the host daemon, so its bundle changes, although the live tunnel runs in the server's `connect` plugin. |

The version stays the upstream one (`0.45.0`). Hosts, plugin `engines` checks
and the Mac self-update all compare versions, and a suffix buys nothing that
the install path does not already show: `~/.bb/bb-app-runtime.json`
records `entryPath`, which names the build directory.

## Build

You need Node ≥ 22.19 and pnpm 9.15.0. Upstream CI builds with Node 24. Node
22.23 builds the same code.

`scripts/fork/build` runs:

```bash
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
├── desktop-v0.45.0-9-gfddc3c8a1/
├── current -> desktop-v0.45.0-9-gfddc3c8a1
├── previous                          the build current pointed at before the last deploy
└── last-deploy-check.txt             status output written 75 s after a full restart
```

The systemd drop-in `~/.config/systemd/user/bb-app.service.d/fork.conf`
starts `current/bin/bb-app start` and never changes again. `deploy` writes it
the first time.

A deploy installs the build into its own prefix and points `current` at it
(`ln -sfn` is atomic). Then it restarts one of two ways:

| Restart     | When                                                                                                                                                             | Agents         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| server only | the running launcher has the launcher patches, the drop-in starts `current`, and the version, `daemon-bundle.mjs`, `dist/bb-app.js` and migrations are unchanged | keep running   |
| full        | anything else: a new upstream version, host protocol, daemon or launcher change, or `--full`                                                                     | all turns stop |

Why the server alone is enough: `bb-app start` is a supervisor with two
children, the server and the host daemon. Agents run under the daemon. When
the server exits, the supervisor starts it again. Because of the launcher
patches, it starts it from the build `current` points to, provided the
supervisor itself was launched as bb-app's own entrypoint and that build has
the same host daemon. In any other case, the supervisor keeps the running
build and logs why, so a mistaken server-only restart can never pair a new
server with an old daemon. Desktop and npm launches never follow anything.

A server-only restart takes about 3 s, and the daemon reconnects. It is safe
from a BB thread because it kills only the server process. Open browser tabs
keep the old UI until they reload.

A full restart runs `systemctl --user restart bb-app.service` from a
transient unit 15 s later. Every agent process lives in the `bb-app.service`
cgroup, so it stops every running turn, including the shell that ran
`deploy`.

The launcher patches only work once the running launcher contains them. The
first switch to a patched 0.45.0 build is always a full restart.

Never add `--in-app-updates` to the unit. Since 0.45.0, that flag makes
`bb-app` a shim that runs the newest of its own package and any version
installed from Settings → Updates. A click in Settings would then move the
service onto upstream npm. Without the flag (our unit), Settings cannot
replace the fork.

## Test a build in isolation, on a copy of real data

```bash
scripts/fork/build
scripts/fork/check            # or --keep, then scripts/fork/check --stop
```

`check` works in `.fork-build/check`, on disk:

1. It installs the tarball into its own prefix.
2. It copies `bb.db` and the data of the credential-free plugins (Initiatives,
   Advisor, Plans, Questions, Sidebar, Editor, Machine load, Threads) with
   `VACUUM INTO`. That takes about 6 s for 3 GB. `.backup` never finishes on
   the live database.
3. It deletes the Connect tunnel credential, the push subscription and the
   Account Pooler and Executor credentials from the copy. It disables
   providers, automations and scheduled sends. It points every path plugin
   at a copy of its source directory, because a path plugin's frontend is
   rebuilt into its source. It points every built-in at the test prefix.
   It stops if any plugin still points outside the copy.
4. It refuses to start if 48886 or 48887 is in use. It starts BB with
   `env -i`, a fake `HOME` and its own data dir and ports. It never copies
   `host-id`, so the test daemon registers as a new host and never acts on
   the live host's worktrees. It confirms that the server answering is its
   own.
5. It prints the version and protocol, the migrations it ran with the time to
   healthy, plugin states, server log errors and warnings, Connect status,
   and the restart a deploy of this build would need.
6. It stops the instance and deletes the copy, also on failure.

For screenshots, `agent-browser` needs `--args "--no-sandbox"` on this host.
Headless Chrome reports `hover: none`, so hover-revealed controls stay hidden.
Force them visible with an injected style when a screenshot needs them.

### Result for 0.45.0 (2026-10-06)

- **Migrations.** The copy went from 119 to 138 migrations (19 new). The
  server answered `/health` 2.0 s after start; the slowest statement was a new
  `events` index at 0.63 s. The first-start log had no warnings or errors.
  Later logs of a long-running copy do contain errors, mostly requests for the
  copied hosts, which are offline there. Those are expected and are not
  migration failures.
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

The coordinator runs this, when no turns are running:

```bash
cd ~/Code/bb
scripts/fork/deploy --dry-run       # read the plan
scripts/fork/deploy
```

For this swap, the plan reports a full restart for five reasons: the running
launcher predates the patches, the drop-in does not start `current` yet, and
the version, daemon bundle and migrations all change. It also reports a
backup. `deploy` stops at the first failure, before anything live changes,
and runs these steps in order:

1. Builds HEAD with `scripts/fork/build`.
2. Installs into `~/.local/share/bb-fork/<git describe>`. It checks that the
   prefix has `bin/bb-app` and that its version and daemon bundle match the
   tarball.
3. Backs up `bb.db` and every plugin `data.db` into a new
   `~/.bb-backups/<date-time>-pre-<build>/`, then verifies the copy. The copied
   `bb.db` must report the live migration count, and each plugin copy must
   pass `pragma quick_check`.
4. Records the build it replaces in `previous`, repoints `current`, and, the
   first time, writes the drop-in and runs `daemon-reload`.
5. Schedules the full restart 15 s out, and `status` into
   `last-deploy-check.txt` 75 s out.

After the restart, read `~/.local/share/bb-fork/last-deploy-check.txt` or run
`scripts/fork/status`. Expect 0.45.0 with protocol 227, and server and daemon
both under the new build. Also check `bb plugin list`.

What to expect in the first minutes:

- Each path plugin logs `rebuilding frontend bundle (built with SDK 0.4.87,
running SDK is 0.6.15)` once. The rebuilt `dist/` lands in
  `~/Code/bb-plugins/plugins/*/dist`, which `.gitignore` excludes, so the
  checkout stays clean.
- The new built-in `thread-list` plugin migrates the sidebar preferences
  stored in BB settings. Our `sidebar` plugin keeps rendering the sidebar.
- The two Macs reconnect after updating themselves (see Compatibility).

### Roll back

```bash
scripts/fork/rollback --dry-run --restore-db ~/.bb-backups/<date-time>-pre-<build>
scripts/fork/rollback --restore-db ~/.bb-backups/<date-time>-pre-<build>
```

0.45.0 ran 19 migrations, so going back to 0.43.1 needs the pre-swap
databases. Changes made since the backup are lost. `rollback` refuses to go
to a build with different migrations without `--restore-db`. It checks the
backup's `bb.db` with `pragma quick_check`, points `current` at `previous`,
and runs a transient unit 15 s later that stops the service, restores
`bb.db` and the plugin databases, and starts it again.

Between builds with the same migrations, a plain `scripts/fork/rollback`
toggles back to `previous`, server-only when allowed. `--to <build>` picks
another prefix. `--npm` removes the drop-in so the unit runs
`~/.npm-global/bin/bb-app` again.

0.43.1 rebuilds the plugin frontends again on its first start, because it
rebuilds on any SDK mismatch. The Macs need a manual step: once they have
updated themselves to protocol 227, a 0.43.1 server (207) is older, and their
daemons refuse to downgrade. Reinstall `bb-app@0.43.1` into each Mac's
machine-service prefix and restart that service.

## Upgrade the fork to a new upstream release

```bash
scripts/fork/status --fetch                   # shows a newer desktop-v* tag
scripts/fork/upgrade desktop-v0.46.0
```

`upgrade` refuses a dirty tree or a branch other than `erwin`. It keeps the
old stack as `erwin-on-<old version>`, then runs
`git rebase --onto <tag> <old base> erwin`. On a conflict it stops with the
conflicted files. Resolve them, `git add`, `git rebase --continue`, then
`scripts/fork/upgrade <tag> --continue`. `git rebase --abort` undoes it. It
then builds, runs `check`, and summarizes the replayed commits, the host
protocol, plugin SDK and migration changes, and the changelog sections.

Then the coordinator pushes with `git push --force-with-lease origin erwin`
and runs `deploy`. A new upstream version is always a full restart. Compare
against the official tarball (How close the fork build is to npm) when the
upgrade touches the build or packaging.

`erwin-on-0.43.1` holds the stack before the 0.45.0 rebase, which replayed
cleanly.

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
