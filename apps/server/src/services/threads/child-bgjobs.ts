import { execFile } from "node:child_process";

const BGJOB_UNIT = /^bgjob-(.+)-\d{8}T\d{6}Z-\d+\.service$/;

export function parseBgjobThreadIds(output: string): Set<string> {
  const threadIds = new Set<string>();
  for (const line of output.split("\n")) {
    const match = BGJOB_UNIT.exec(line.trim().split(/\s+/)[0] ?? "");
    if (match?.[1]) threadIds.add(match[1]);
  }
  return threadIds;
}

export function listThreadsAwaitingBgjob(): Promise<Set<string>> {
  if (process.platform !== "linux") {
    return Promise.resolve(new Set());
  }
  return new Promise((resolve, reject) => {
    execFile(
      "systemctl",
      [
        "--user",
        "list-units",
        "--plain",
        "--no-legend",
        "--no-pager",
        "--type=service",
        "--state=active,activating",
        "bgjob-*",
      ],
      { timeout: 5_000, maxBuffer: 1 << 20 },
      (error, stdout) =>
        error ? reject(error) : resolve(parseBgjobThreadIds(stdout)),
    );
  });
}
