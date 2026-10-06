import changelogSource from "../../../../../CHANGELOG.md?raw";
import {
  parseChangelog,
  type ChangelogEntry,
} from "../../../../../changelog-parser";
export { RELEASE_META } from "../../../../../changelog-metadata";
export type {
  ReleaseHero,
  ReleaseMeta,
} from "../../../../../changelog-metadata";
export type { ChangelogBlock } from "../../../../../changelog-parser";
export type { ChangelogEntry } from "../../../../../changelog-parser";

const CHANGELOG_URL = "https://getbb.app/changelog";
const LATEST_CHANGELOG_SOURCE_URL =
  "https://raw.githubusercontent.com/get-bb/bb/main/CHANGELOG.md";

export const CHANGELOG_ENTRIES = parseChangelog(changelogSource);

export function changelogUrl(version: string): string {
  return `${CHANGELOG_URL}#${version.replaceAll(".", "-")}`;
}

function versionParts(version: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(version);
  return match?.[1] === undefined ? null : match[1].split(".").map(Number);
}

export function compareChangelogVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (leftParts === null || rightParts === null) {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const partCount = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < partCount; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export interface WhatsNewReleases {
  current: ChangelogEntry;
  skipped: ChangelogEntry[];
  updatedFrom: string | null;
}

export function selectWhatsNewReleases({
  entries,
  installedVersion,
  previousVersion,
}: {
  entries: readonly ChangelogEntry[];
  installedVersion: string | null;
  previousVersion: string | null;
}): WhatsNewReleases | null {
  const current =
    (installedVersion === null
      ? undefined
      : entries.find(
          (entry) =>
            compareChangelogVersions(entry.version, installedVersion) <= 0,
        )) ?? entries[0];
  if (current === undefined) {
    return null;
  }
  if (
    previousVersion === null ||
    compareChangelogVersions(previousVersion, current.version) >= 0
  ) {
    return { current, skipped: [], updatedFrom: null };
  }
  return {
    current,
    skipped: entries.filter(
      (entry) =>
        compareChangelogVersions(entry.version, previousVersion) > 0 &&
        compareChangelogVersions(entry.version, current.version) < 0,
    ),
    updatedFrom: previousVersion,
  };
}

export interface WhatsNewVersionStorage {
  getItem: (key: string, initialValue: string) => string;
  setItem: (key: string, value: string) => void;
}

const SEEN_VERSION_STORAGE_KEY = "bb.settings.updates.whats-new-seen-version";
const PREVIOUS_VERSION_STORAGE_KEY =
  "bb.settings.updates.whats-new-previous-version";

export function recordWhatsNewVersion(
  storage: WhatsNewVersionStorage,
  version: string,
): string | null {
  const seen = storage.getItem(SEEN_VERSION_STORAGE_KEY, "");
  if (seen.length > 0 && compareChangelogVersions(seen, version) < 0) {
    storage.setItem(PREVIOUS_VERSION_STORAGE_KEY, seen);
    storage.setItem(SEEN_VERSION_STORAGE_KEY, version);
    return seen;
  }
  if (seen.length === 0) {
    storage.setItem(SEEN_VERSION_STORAGE_KEY, version);
    return null;
  }
  if (seen !== version) {
    return null;
  }
  const previous = storage.getItem(PREVIOUS_VERSION_STORAGE_KEY, "");
  return previous.length === 0 ? null : previous;
}

export async function fetchChangelogEntries(
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<ChangelogEntry[]> {
  const response = await fetchFn(LATEST_CHANGELOG_SOURCE_URL, { signal });
  if (!response.ok) {
    throw new Error(`Changelog request failed (${response.status})`);
  }
  const entries = parseChangelog(await response.text());
  if (entries.length === 0) {
    throw new Error("The changelog has no releases");
  }
  return entries;
}
