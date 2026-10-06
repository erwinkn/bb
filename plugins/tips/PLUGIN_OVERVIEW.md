Learn what bb can do, one tip at a time. Tips shows a single short tip below the composer on the New thread page, picked for how you use bb right now.

## What you get

- One quiet tip at a time, and at most one new tip a day.
- Tips about bb features and workflows people often miss: subthreads, Account Pooler, the mobile app, Browser Automation, automations, handoff, the command palette, and asking bb to set itself up or build you a tool.
- A one-click action on most tips: fill the composer with a prompt to try, open the right Settings page, or open the command palette or thread search.
- A Show tips switch in the plugin settings that turns tips off everywhere.

## How it works

A tip appears only when it fits your setup. Tips for desktop or keyboard features stay off phones, Browser Automation tips stay off Windows, and a tip for a plugin waits until that plugin is installed. Dismissing a tip retires it for good. A tip also retires once you take its action, once bb sees you using the feature (for example, your first subthread or queued follow-up), or after it has been shown on two days. After an update, a What's new tip links to Settings → Updates once.

Tips keeps its state and its shown, dismissed, and acted counts in its own plugin storage on this bb server. It sends nothing anywhere.

## For agents and scripts

Use the `bb tips` command:

- `bb tips` lists the tips that are eligible now and marks the one showing today. Add `--all` to include dismissed, retired, held, and not-applicable tips.
- `bb tips dismiss <id>` retires one tip.
- `bb tips reset` brings back every dismissed and retired tip.

Add `--json` for machine-readable output. Turn tips off with `bb plugin config bb--tips set enabled false`.
