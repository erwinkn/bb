export interface ContentLink {
  label: string;
  href: string;
}

export const GUIDE_LINKS: ContentLink[] = [];

export const COMPARE_LINKS: ContentLink[] = [
  { label: "bb vs Superset", href: "/compare/superset-alternative" },
  {
    label: "Vibe Kanban alternative",
    href: "/compare/vibe-kanban-alternative",
  },
  { label: "Conductor alternatives", href: "/compare/conductor-alternatives" },
  { label: "T3 Code alternatives", href: "/compare/t3-code-alternatives" },
  { label: "Cursor alternative", href: "/compare/cursor-alternative" },
];

export const CONTENT_PATHS: string[] = [...GUIDE_LINKS, ...COMPARE_LINKS].map(
  (link) => link.href,
);
