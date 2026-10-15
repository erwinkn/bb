// FORK (T145, A473, W472): one past upstream's 237, because the daemon must
// pass each turn's tools to its runtime (FORK.md, per-turn context) and
// handle thread.backgroundTask.stop. An upstream daemon lacks them, so the
// server refuses it and it updates itself. Keep it one past upstream's on
// every upgrade, so no upstream daemon ever matches.
export const HOST_DAEMON_PROTOCOL_VERSION = 238 as const;

export const HOST_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;

export const HOST_DAEMON_TERMINAL_EXIT_RETENTION_MS = 30 * 60 * 1000;
