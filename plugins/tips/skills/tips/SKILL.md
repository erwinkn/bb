---
name: tips
description: "List, rotate, hide, dismiss, or reset the tips bb shows on the New thread page, or turn tips off."
---

# Tips

bb shows three tips under the composer on the desktop and web New thread page
(never on phones or compact layouts). The set stays the same all day. Use the
`bb tips` command to inspect or change them.

```sh
bb tips [--all] [--json]
bb tips more [--json]
bb tips hide [--undo] [--json]
bb tips dismiss <id> [--json]
bb tips reset [--json]
```

- `bb tips` lists the tips eligible now, highest priority first, and marks the
  three showing today. Tips limited to the desktop or web app are listed
  because the CLI cannot tell which app the person uses. `--all` adds every tip
  with its status: `dismissed`, `retired` (with `used`, `acted`, or `seen`),
  `held`, or `not-applicable`.
- `bb tips more` swaps today's tips for the next three, like More ideas.
- `bb tips hide` hides tips until tomorrow; `--undo` shows them again.
- `bb tips dismiss <id>` retires a tip for good. Run `bb tips --all` for ids.
- `bb tips reset` clears dismissals, retirements, shown counts, and today's
  hiding. Features bb has already seen in use stay recorded, so their tips stay
  retired.

Turn tips off or on with `bb plugin config bb--tips set enabled false|true`. Only
dismiss, hide, or reset tips when the person asks.
