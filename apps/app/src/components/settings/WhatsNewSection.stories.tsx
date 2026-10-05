import type { ReactNode } from "react";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { SettingsStoryChrome } from "../../../.ladle/story-settings-chrome";
import { SettingsUpdatesStory } from "../../../.ladle/settings-story-fixtures";
import { WhatsNewView } from "./WhatsNewSection";
import {
  CHANGELOG_ENTRIES,
  selectWhatsNewReleases,
  type ChangelogEntry,
  type WhatsNewReleases,
} from "./changelog-preview";

export default {
  title: "settings/Updates/What's new",
};

function releasesFor(
  installedVersion: string,
  previousVersion: string | null,
): WhatsNewReleases {
  const releases = selectWhatsNewReleases({
    entries: CHANGELOG_ENTRIES,
    installedVersion,
    previousVersion,
  });
  if (releases === null) {
    throw new Error(`Missing changelog fixture ${installedVersion}`);
  }
  return releases;
}

function entryFor(version: string): ChangelogEntry {
  const entry = CHANGELOG_ENTRIES.find(
    (candidate) => candidate.version === version,
  );
  if (entry === undefined) {
    throw new Error(`Missing changelog fixture ${version}`);
  }
  return entry;
}

const UNANNOUNCED_RELEASE: ChangelogEntry = {
  version: "99.0.0",
  lede: [
    {
      kind: "paragraph",
      text: "A release whose headline and date have not been published yet.",
    },
  ],
  sections: [
    {
      title: "Highlights",
      blocks: [
        {
          kind: "list",
          items: [
            "**Release notes in Settings:** Settings → Updates keeps the installed release and anything you skipped.",
          ],
        },
      ],
    },
    {
      title: "Fixes",
      blocks: [
        {
          kind: "paragraph",
          text: "Fix stale update badges after relaunching the desktop app.",
        },
      ],
    },
  ],
};

function Frame({ children }: { children: ReactNode }) {
  return <div className="w-full max-w-3xl">{children}</div>;
}

export function InSettings() {
  return (
    <SettingsStoryChrome activeSection="updates">
      <SettingsUpdatesStory />
    </SettingsStoryChrome>
  );
}

export function States() {
  return (
    <StoryCard className="max-w-6xl" labelWidth="240px">
      <StoryRow label="Returning visit" hint="No update since the last visit.">
        <Frame>
          <WhatsNewView
            releases={releasesFor("0.45.0", null)}
            available={null}
          />
        </Frame>
      </StoryRow>
      <StoryRow
        label="Just updated, one release"
        hint="0.44.0 → 0.45.0, arriving from the new-thread tip."
      >
        <Frame>
          <WhatsNewView
            releases={releasesFor("0.45.0", "0.44.0")}
            available={null}
          />
        </Frame>
      </StoryRow>
      <StoryRow
        label="Skipped several releases"
        hint="0.42.0 → 0.45.0; skipped releases collapse below the installed one."
      >
        <Frame>
          <WhatsNewView
            releases={releasesFor("0.45.0", "0.42.0")}
            available={null}
          />
        </Frame>
      </StoryRow>
      <StoryRow
        label="Update available"
        hint="Installed 0.44.0; the 0.45.0 notes sit collapsed above."
      >
        <Frame>
          <WhatsNewView
            releases={releasesFor("0.44.0", null)}
            available={entryFor("0.45.0")}
          />
        </Frame>
      </StoryRow>
      <StoryRow
        label="Release without metadata"
        hint="No published headline: the version line leads."
      >
        <Frame>
          <WhatsNewView
            releases={{
              current: UNANNOUNCED_RELEASE,
              skipped: [],
              updatedFrom: null,
            }}
            available={null}
          />
        </Frame>
      </StoryRow>
      <StoryRow label="390px" hint="Narrow viewport, skipped releases.">
        <div className="w-full max-w-sm">
          <WhatsNewView
            releases={releasesFor("0.45.0", "0.42.0")}
            available={null}
          />
        </div>
      </StoryRow>
    </StoryCard>
  );
}
