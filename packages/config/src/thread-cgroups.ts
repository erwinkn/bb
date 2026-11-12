export const THREAD_CGROUP_SLICE = "app-bb.slice";
export const THREAD_CGROUP_SLICE_PATH = `app.slice/${THREAD_CGROUP_SLICE}`;

const UNIT_SAFE_THREAD_ID = /^[A-Za-z0-9_]+$/u;
const THREAD_SCOPE_UNIT =
  /^bb-(?:thread-([A-Za-z0-9_]+)|boost-([A-Za-z0-9_]+)-[^/]+)\.scope$/u;
const USER_MANAGER_CGROUP = /^(.*\/user@\d+\.service)(\/.*)?$/u;

export function isUnitSafeThreadId(threadId: string): boolean {
  return UNIT_SAFE_THREAD_ID.test(threadId);
}

export function threadScopeUnitName(threadId: string): string {
  return `bb-thread-${threadId}.scope`;
}

export function threadIdFromScopeUnitName(unitName: string): string | null {
  const match = THREAD_SCOPE_UNIT.exec(unitName);
  return match?.[1] ?? match?.[2] ?? null;
}

export function parseUserManagerCgroup(
  procSelfCgroup: string,
): { managerPath: string; ownPath: string } | null {
  const line = procSelfCgroup
    .split("\n")
    .find((entry) => entry.startsWith("0::"));
  const ownPath = line?.slice(3).trim();
  if (!ownPath) return null;
  const match = USER_MANAGER_CGROUP.exec(ownPath);
  return match?.[1] ? { managerPath: match[1], ownPath } : null;
}
