---
name: tips
description: "List, dismiss, or reset the tips bb shows on the New thread page, or turn tips off."
---

# Tips

bb shows at most one new tip a day on the New thread page. Use the `bb tips`
command to inspect or change them.

```sh
bb tips [--all] [--json]
bb tips dismiss <id> [--json]
bb tips reset [--json]
```

- `bb tips` lists the tips eligible now, highest priority first, and marks the
  one showing today. Tips limited to the desktop, web, or mobile app are listed
  because the CLI cannot tell which app the person uses. `--all` adds every tip
  with its status: `dismissed`, `retired` (with `used`, `acted`, or `seen`),
  `held`, or `not-applicable`.
- `bb tips dismiss <id>` retires a tip for good. Run `bb tips --all` for ids.
- `bb tips reset` clears dismissals, retirements, and shown counts. Features bb
  has already seen in use stay recorded, so their tips stay retired.

Turn tips off or on with `bb plugin config tips set enabled false|true`. Only
dismiss or reset tips when the person asks.
