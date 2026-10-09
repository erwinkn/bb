// FORK (T145, A473): 228 because enforcement of a thread's memory mode needs
// the daemon to pass each turn's tools to its runtime (FORK.md, per-turn
// context). A 227 daemon drops them, so the server refuses it and it updates
// itself. Keep it one past upstream's on every upgrade, so no upstream daemon
// ever matches.
export const HOST_DAEMON_PROTOCOL_VERSION = 228 as const;

export const HOST_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;

export const HOST_DAEMON_TERMINAL_EXIT_RETENTION_MS = 30 * 60 * 1000;
