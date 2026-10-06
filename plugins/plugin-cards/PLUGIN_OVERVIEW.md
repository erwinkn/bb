When you ask an agent whether bb can do something, it can answer with a card for an existing plugin instead of a name to search for. Click the card to open that plugin's detail page beside the conversation.

## What you get

- A compact card in the agent's reply with the plugin's icon, name, description, category, and source.
- The plugin's status: **Enabled**, **Disabled**, **Not installed**, or **Incompatible**.
- One button: **Open** for an enabled plugin, **Enable** for a disabled one, and **Install** for one you don't have yet. Clicking anywhere on the card does the same.
- Third-party marketplace plugins are labeled **Not reviewed by BB**.

## How it works

The agent calls the `show_plugin_card` tool with a plugin id from `bb plugin search <terms> --json`. The tool checks that the id is installed or listed in the plugin store, then returns a line the agent copies into its reply:

```text
::plugin-card{id="browser-automation"}
```

The card and its button only open the detail page. Installing and enabling still happen there, with the usual confirmation and trust warnings; the agent and the card never change your plugins themselves.

The BB guide plugin's `find-plugins` skill tells agents when to search the store and how to recommend plugins. Turn off Plugin cards in Settings → Plugins, or run `bb plugin disable bb--plugin-cards`, to remove the tool and cards.
