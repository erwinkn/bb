import type { TipAction, TipClient } from "./contract.js";

export const ACCOUNT_POOL_PLUGIN_ID = "account-pool";
export const AUTOMATIONS_PLUGIN_ID = "automations";
export const BROWSER_AUTOMATION_PLUGIN_ID = "browser-automation";
export const PROVIDER_USAGE_PLUGIN_ID = "bb--provider-usage";
export const POOLED_PROVIDER_IDS: readonly string[] = ["claude-code", "codex"];

export interface TipSignals {
  client: TipClient | null;
  serverPlatform: string;
  appVersion: string | null;
  firstSeenVersion: string | null;
  daysSinceFirstSeen: number;
  threadCount: number;
  availableProviderCount: number;
  providersUsed: readonly string[];
  installedPlugins: Readonly<Record<string, boolean>>;
  hasFinishedThread: boolean;
  finishedThreadCount: number;
  hasChildThread: boolean;
  hasAutomationThread: boolean;
  rateLimited: boolean;
  queuedFollowUp: boolean;
  usedMobileApp: boolean;
}

export interface TipDefinition {
  id: string;
  title: string;
  body: string;
  action: TipAction | null;
  priority: number;
  held: boolean;
  perVersion: boolean;
  maxShowDays: number;
  when(signals: TipSignals): boolean;
  used(signals: TipSignals): boolean;
}

const DEFAULT_MAX_SHOW_DAYS = 2;
const POWER_USER_THREAD_COUNT = 50;
const NEW_USER_DAYS = 14;

function isInstalled(signals: TipSignals, pluginId: string): boolean {
  return pluginId in signals.installedPlugins;
}

function isEnabled(signals: TipSignals, pluginId: string): boolean {
  return signals.installedPlugins[pluginId] === true;
}

function onClient(
  signals: TipSignals,
  test: (client: TipClient) => boolean,
): boolean {
  return signals.client === null || test(signals.client);
}

function hasKeyboard(client: TipClient): boolean {
  return client.surface === "desktop" || client.surface === "web";
}

function isWindowsClient(client: TipClient): boolean {
  return client.os === "windows";
}

function never(): boolean {
  return false;
}

function tip(
  definition: Omit<
    TipDefinition,
    "held" | "perVersion" | "maxShowDays" | "used"
  > &
    Partial<
      Pick<TipDefinition, "held" | "perVersion" | "maxShowDays" | "used">
    >,
): TipDefinition {
  return {
    held: false,
    perVersion: false,
    maxShowDays: DEFAULT_MAX_SHOW_DAYS,
    used: never,
    ...definition,
  };
}

export const TIP_CATALOG: readonly TipDefinition[] = [
  tip({
    id: "whats-new",
    title: "What's new in v{version}",
    body: "See what changed in this update.",
    action: {
      kind: "route",
      label: "See what's new",
      path: "/settings/updates#whats-new",
    },
    priority: 1000,
    perVersion: true,
    maxShowDays: 1,
    when: (signals) =>
      signals.appVersion !== null &&
      signals.firstSeenVersion !== null &&
      signals.appVersion !== signals.firstSeenVersion,
  }),
  tip({
    id: "account-pool",
    title: "Keep working through usage limits",
    body: "Account Pooler moves Claude Code and Codex threads to another account you own when one runs out.",
    action: {
      kind: "route",
      label: "Set up",
      path: "/settings/plugins/account-pool",
    },
    priority: 120,
    when: (signals) =>
      isInstalled(signals, ACCOUNT_POOL_PLUGIN_ID) &&
      signals.providersUsed.some((id) => POOLED_PROVIDER_IDS.includes(id)) &&
      (signals.rateLimited || signals.threadCount >= POWER_USER_THREAD_COUNT),
    used: (signals) => isEnabled(signals, ACCOUNT_POOL_PLUGIN_ID),
  }),
  tip({
    id: "subthreads",
    title: "Run work in parallel",
    body: "Ask bb to spin up subthreads that try three approaches at once, or one that reviews this work.",
    action: {
      kind: "prompt",
      label: "Try it",
      prompt:
        "Spin up three subthreads that each try a different approach to this task, then compare their results and recommend one. Task: ",
    },
    priority: 110,
    when: (signals) => signals.hasFinishedThread,
    used: (signals) => signals.hasChildThread,
  }),
  tip({
    id: "set-up-for-me",
    title: "Ask bb to set things up",
    body: "bb can change its own settings, add machines, and configure providers when you ask.",
    action: {
      kind: "prompt",
      label: "Try it",
      prompt:
        "Review my bb setup (settings, machines, and providers), suggest improvements, and make the changes I approve.",
    },
    priority: 100,
    when: (signals) => signals.hasFinishedThread,
  }),
  tip({
    id: "phone",
    title: "Check on your agents from your phone",
    body: "The bb mobile app lets you follow threads and answer questions away from your desk.",
    action: { kind: "route", label: "Get the app", path: "/settings/mobile" },
    priority: 90,
    when: (signals) =>
      signals.hasFinishedThread &&
      onClient(
        signals,
        (client) => client.surface === "desktop" || client.surface === "web",
      ),
    used: (signals) => signals.usedMobileApp,
  }),
  tip({
    id: "browser-automation",
    title: "Let the agent test your app",
    body: "Ask your agent to turn on Browser Automation, then click through your app and report what breaks.",
    action: {
      kind: "prompt",
      label: "Try it",
      prompt:
        "Turn on the Browser Automation plugin if it is off, then open my app in a browser, click through the main flow, and tell me what is broken.",
    },
    priority: 80,
    when: (signals) =>
      signals.hasFinishedThread &&
      signals.serverPlatform !== "win32" &&
      onClient(signals, (client) => !isWindowsClient(client)),
    used: (signals) => isEnabled(signals, BROWSER_AUTOMATION_PLUGIN_ID),
  }),
  tip({
    id: "build-plugin",
    title: "Ask the agent to build you a tool",
    body: "Your agent can write bb plugins for you, from a dashboard page to a new panel or command.",
    action: {
      kind: "prompt",
      label: "Try it",
      prompt: "Build me a bb plugin that ",
    },
    priority: 75,
    when: (signals) =>
      signals.hasFinishedThread && signals.daysSinceFirstSeen <= NEW_USER_DAYS,
  }),
  tip({
    id: "open-threads-that-need-me",
    title: "See every thread that needs you",
    body: "Ask bb to open each thread that is waiting on you side by side in split panes.",
    action: {
      kind: "prompt",
      label: "Try it",
      prompt:
        "Find my threads that are waiting on me (open questions, errors, or unread results) and open them side by side in split panes with bb thread open --split.",
    },
    priority: 70,
    when: (signals) =>
      signals.threadCount >= 5 && onClient(signals, hasKeyboard),
  }),
  tip({
    id: "morning-digest",
    title: "Get a morning email digest",
    body: "Ask the agent to build an automation that reads your inbox in bb's browser each morning and sends you a short digest.",
    action: {
      kind: "prompt",
      label: "Try it",
      prompt:
        "Set up an automation that runs every weekday at 8am, uses Browser Automation to read my unread email in bb's browser (where I am signed in), and writes me a short digest of what needs my attention. Turn on Browser Automation first if it is off.",
    },
    priority: 65,
    when: (signals) =>
      signals.finishedThreadCount >= 3 &&
      isEnabled(signals, AUTOMATIONS_PLUGIN_ID) &&
      signals.serverPlatform !== "win32" &&
      onClient(signals, (client) => !isWindowsClient(client)),
  }),
  tip({
    id: "decision-buttons",
    title: "Turn decisions into buttons",
    body: "Ask the agent to build a plugin that shows the choices it needs from you as one-click buttons.",
    action: {
      kind: "prompt",
      label: "Try it",
      prompt:
        "Build me a bb plugin that gives you a tool to ask me a decision with one-click answer buttons in the thread, then use it whenever you need a choice from me.",
    },
    priority: 60,
    when: (signals) => signals.finishedThreadCount >= 3,
  }),
  tip({
    id: "automations",
    title: "Run a prompt on a schedule",
    body: "Ask the agent to turn any prompt into an automation that runs every morning or every hour.",
    action: {
      kind: "prompt",
      label: "Try it",
      prompt: "Create an automation that runs every weekday at 9am and ",
    },
    priority: 55,
    when: (signals) =>
      signals.finishedThreadCount >= 5 &&
      isEnabled(signals, AUTOMATIONS_PLUGIN_ID),
    used: (signals) => signals.hasAutomationThread,
  }),
  tip({
    id: "queue-or-steer",
    title: "Add to a running turn",
    body: "While the agent works, steer to change course now, or queue a follow-up that runs when it finishes.",
    action: {
      kind: "route",
      label: "Choose what Enter does",
      path: "/settings",
    },
    priority: 50,
    when: (signals) => signals.finishedThreadCount >= 3,
    used: (signals) => signals.queuedFollowUp,
  }),
  tip({
    id: "handoff",
    title: "Hand off to another model",
    body: "In a thread's model picker, choose Handoff to new thread to continue the work with another provider.",
    action: null,
    priority: 45,
    when: (signals) =>
      signals.availableProviderCount >= 2 && signals.threadCount >= 3,
  }),
  tip({
    id: "thread-search",
    title: "Jump to any thread",
    body: "Press {searchKeys} to search your threads.",
    action: { kind: "command", label: "Search", commandId: "thread.search" },
    priority: 42,
    when: (signals) =>
      signals.threadCount >= 10 && onClient(signals, hasKeyboard),
  }),
  tip({
    id: "command-palette",
    title: "Do anything from the keyboard",
    body: "Press {paletteKeys} to search bb's commands and settings.",
    action: { kind: "command", label: "Open", commandId: "palette.open" },
    priority: 40,
    when: (signals) =>
      signals.daysSinceFirstSeen >= 3 && onClient(signals, hasKeyboard),
  }),
  tip({
    id: "provider-usage",
    title: "See your usage across providers",
    body: "Provider usage shows how much of each account's limits you have used and when they reset.",
    action: {
      kind: "route",
      label: "Open",
      path: "/settings/plugins/bb--provider-usage",
    },
    priority: 35,
    when: (signals) =>
      signals.threadCount >= 10 && isEnabled(signals, PROVIDER_USAGE_PLUGIN_ID),
  }),
  tip({
    id: "another-server",
    title: "Connect to bb on another machine",
    body: "In the bb menu, choose Desktop Settings, then Server, then Add Server to switch this app to another bb server.",
    action: null,
    priority: 30,
    when: (signals) =>
      signals.finishedThreadCount >= 3 &&
      onClient(
        signals,
        (client) => client.surface === "desktop" && client.os === "macos",
      ),
  }),
];
