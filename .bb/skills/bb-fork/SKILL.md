---
name: bb-fork
description: Patch Erwin's fork of BB in ~/Code/bb (web UI, server, daemon, launcher), test the build in an isolated BB on a copy of his real data, and hand the deploy to the coordinator. Use for any change to BB itself, for moving the fork to a new upstream release, and to judge whether a change needs a full restart.
---

# Working on the BB fork

`~/Code/bb` is the main checkout of Erwin's fork of BB. Branch `erwin` is an
upstream release tag (`desktop-vX.Y.Z`) plus our own commits, and it runs as
the live BB on this machine. `FORK.md` is the full runbook, `scripts/fork/`
holds the tools, and `scripts/fork/<tool> --help` explains each one.

## Rules

- Never run `scripts/fork/deploy` or `scripts/fork/rollback`, not even with
  `--dry-run`. Never restart or stop `bb-app.service`, edit its drop-in, or
  touch `~/.local/share/bb-fork`. The coordinator deploys.
- Never push, and never open PRs or issues upstream. Commit locally on
  `erwin`; the coordinator pushes.
- Never write to `~/.bb`. Tests use `scripts/fork/check`, which works on a
  sanitized copy.
- Never put a checkout, worktree or `pnpm install` under `/tmp`. It is a RAM
  disk, and pnpm copies the whole store there.
- Follow the repository's `AGENTS.md`. In particular, code comments are
  forbidden, and `oxlint` enforces it.

## Make a patch

1. Read `git log --oneline $(git describe --tags --abbrev=0 --match 'desktop-v*')..erwin`
   and FORK.md's Patches table, so you extend an existing patch instead of
   overlapping it.
2. Keep the change small and in as few files as possible. Every upstream
   upgrade has to replay it. Prefer new files (for example a new test file)
   over edits to upstream ones.
3. Verify the touched package. Run tests with a clean environment, because
   this shell exports the live `BB_SERVER_URL`:

   ```bash
   cd ~/Code/bb/apps/app && pnpm run typecheck && pnpm run lint
   env -i HOME=/tmp/bb-test-home USER=$USER PATH=/usr/local/bin:/usr/bin:/bin \
     ./node_modules/.bin/vitest run --config vitest.config.ts src/components/thread
   ```

4. Commit one coherent change per commit on `erwin`. End the message with
   the attribution line your environment asks for.
5. Add the patch to FORK.md's Patches table (what it does, which files) in
   the same or a follow-up commit.

## Test it

```bash
scripts/fork/build                 # ~25-50 s; prints .fork-build/bb-app-<version>.tgz
scripts/fork/check                 # isolated BB on a copy of ~/.bb, prints a summary, cleans up
scripts/fork/check --keep          # same, but leaves it running on :48886 for screenshots
scripts/fork/check --stop          # stop and delete a kept instance
```

`check` prints the version, the migrations it ran, plugin states, server log
errors, and the restart a deploy would need (`deploy:` line). Credentials are
stripped from the copy, so `account-pool-local`, `github-prs` and `voice-mode`
always report `needs-configuration`. That is expected.

For UI changes, take screenshots of real threads in the kept instance:

```bash
export AGENT_BROWSER_SESSION=bb-fork-check
agent-browser --args --no-sandbox open http://127.0.0.1:48886/projects/<project>/threads/<thread>
agent-browser set viewport 1440 960      # desktop; `set device "iPhone 14"` for narrow
agent-browser set media dark             # and light
agent-browser screenshot .fork-build/evidence/<name>.png
```

Headless Chrome reports `hover: none`, so hover-revealed controls stay
hidden. Inject a style to show them when they matter. Find real thread IDs
with `sqlite3 .fork-build/check/data/bb.db "select id, project_id, title from threads order by updated_at desc limit 10"`.

## Server-only or full restart

`deploy` decides automatically, and `check` prints the same decision. A
**server-only** restart takes about 3 s and leaves every agent running. It is
possible when all of these hold:

- same `bb-app` version as the running build
- byte-identical `host-daemon/dist/daemon-bundle.mjs`
- byte-identical launcher (`dist/bb-app.js`)
- identical database migrations (`server/dist/drizzle`)
- the running launcher has the follow-install patch, and the systemd drop-in
  starts `~/.local/share/bb-fork/current`

In practice:

| You changed                                                                                      | Restart                  |
| ------------------------------------------------------------------------------------------------ | ------------------------ |
| `apps/app` (web UI), most of `apps/server`, bundled plugins                                      | server only              |
| `packages/db` migrations, `apps/host-daemon`, `packages/host-daemon-contract`, `packages/bb-app` | full                     |
| a shared package (`packages/domain`, `server-contract`, ...)                                     | whatever `check` reports |
| a new upstream version                                                                           | always full              |

A full restart stops every running turn on the machine, including the
coordinator's. Say so plainly in your report when your change needs one.

## Move to a new upstream release

```bash
scripts/fork/status --fetch                 # shows whether a newer desktop-v* tag exists
scripts/fork/upgrade desktop-vX.Y.Z         # rebase, build, check, summary
```

On a conflict, `upgrade` stops and lists the files. Resolve each one by
keeping upstream's change and re-applying ours. Then `git add`,
`git rebase --continue`, and `scripts/fork/upgrade desktop-vX.Y.Z --continue`.
`git rebase --abort` undoes everything. The old stack stays as branch
`erwin-on-<old version>`. The summary reports changes in host protocol,
plugin SDK and migrations. A protocol change means the enrolled Macs update
themselves after the deploy. An SDK change means typechecking our plugins in
`~/Code/bb-plugins` against the new SDK; FORK.md has the method.

## Hand off

Report to the coordinator:

- the commits (hashes and one line each) and the files they touch
- what you verified: tests, `check` summary lines, screenshots
- the restart `check` printed (server only, or full and why)
- anything unverified

The coordinator then runs `scripts/fork/deploy` (and pushes `erwin`). If
something is wrong after the deploy, they run `scripts/fork/rollback`.
`scripts/fork/status` is read-only and safe for anyone: running build,
`current`, branch versus upstream and origin, newest backup.
