import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginThreadEventPayloads,
  type PluginTurnFailedEvent,
} from "@get-bb/plugin-sdk";
import { POOLED_PROVIDER_IDS } from "./catalog.js";
import {
  TIPS_CHANGED_CHANNEL,
  tipsRpcContract,
  type TipClient,
  type TipListEntry,
  type TipView,
} from "./contract.js";
import {
  UnknownTipError,
  actOnTip,
  createTipsState,
  deriveSignals,
  dismissTip,
  findTip,
  listTips,
  localDay,
  observeLiveSignals,
  parseTipsState,
  renderTip,
  resetTips,
  retireTips,
  selectTip,
  type TipsState,
} from "./engine.js";
import { collectLiveSignals, createAppVersionReader } from "./signals.js";

const STATE_KEY = "state";

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const LIST_OPTIONS = {
  all: {
    type: "boolean",
    description:
      "Include every tip with its status: dismissed, retired, held, or not applicable",
  },
  json: JSON_OPTION,
} as const;

type Observation =
  | "finishedThread"
  | "childThread"
  | "rateLimited"
  | "queuedFollowUp";
type QueuedEntry = PluginThreadEventPayloads["message.queued"]["entry"];

function isQueuedFollowUp(entry: QueuedEntry): boolean {
  return (
    entry.initiator === "user" &&
    entry.payload.kind === "inline" &&
    entry.sendAt === null &&
    (entry.waitingOn === null ||
      entry.waitingOn.kind === "thread-busy" ||
      entry.waitingOn.kind === "turn-starting")
  );
}

function isRateLimitFailure(event: PluginTurnFailedEvent): boolean {
  return (
    event.errorInfo?.category === "rate-limit" ||
    event.rateLimits?.status === "blocked"
  );
}

function formatTipLine(entry: TipListEntry, all: boolean): string {
  const status =
    entry.status === "current"
      ? " (showing today)"
      : all && entry.status !== "eligible"
        ? ` (${entry.status}${entry.retiredReason === null ? "" : `: ${entry.retiredReason}`})`
        : "";
  return `${entry.id}${status}\n  ${entry.title}: ${entry.body}`;
}

function formatList(
  view: { enabled: boolean; tips: TipListEntry[] },
  all: boolean,
): string {
  const lines: string[] = [];
  if (!view.enabled) {
    lines.push(
      "Tips are turned off. Turn them on in Settings → Installed plugins → Tips.",
    );
  }
  if (view.tips.length === 0) {
    lines.push(all ? "No tips." : "No tips are eligible right now.");
  } else {
    lines.push(...view.tips.map((entry) => formatTipLine(entry, all)));
  }
  return lines.join("\n");
}

function recordObservation(
  observed: TipsState["observed"],
  observation: Observation,
  now: number,
): TipsState["observed"] {
  switch (observation) {
    case "finishedThread":
      return { ...observed, finishedThread: true };
    case "childThread":
      return { ...observed, childThread: true };
    case "rateLimited":
      return { ...observed, rateLimitedAt: observed.rateLimitedAt ?? now };
    case "queuedFollowUp":
      return {
        ...observed,
        queuedFollowUpAt: observed.queuedFollowUpAt ?? now,
      };
  }
}

export default async function tipsPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Show tips",
      description:
        "Show one tip at a time on the New thread page. At most one new tip appears each day.",
      default: true,
    },
  });
  const readAppVersion = createAppVersionReader(bb);
  const knownObservations = new Set<Observation>();
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function loadState(): Promise<TipsState> {
    const stored = await bb.storage.kv.get<unknown>(STATE_KEY);
    if (stored === undefined) return createTipsState(Date.now(), null);
    const parsed = parseTipsState(stored);
    if (parsed !== null) return parsed;
    bb.log.warn("Stored tips state was unreadable; starting fresh");
    return createTipsState(Date.now(), null);
  }

  function updateState(update: (state: TipsState) => TipsState): Promise<void> {
    return serialize(async () => {
      await bb.storage.kv.set(STATE_KEY, update(await loadState()));
    });
  }

  function evaluate<T>(
    client: TipClient | null,
    use: (
      state: TipsState,
      signals: ReturnType<typeof deriveSignals>,
      today: string,
      now: number,
    ) => { state: TipsState; result: T },
  ): Promise<T> {
    return serialize(async () => {
      const now = Date.now();
      const loaded = await loadState();
      const live = await collectLiveSignals(bb, loaded, readAppVersion);
      const observed = observeLiveSignals(loaded, live, client, now);
      const signals = deriveSignals(observed, live, client, now);
      const { state, result } = use(observed, signals, localDay(now), now);
      await bb.storage.kv.set(STATE_KEY, state);
      return result;
    });
  }

  async function isEnabled(): Promise<boolean> {
    return (await settings.get()).enabled;
  }

  async function currentTip(client: TipClient): Promise<TipView | null> {
    if (!(await isEnabled())) return null;
    return evaluate(client, (state, signals, today, now) => {
      const selection = selectTip(state, signals, today, now);
      return {
        state: selection.state,
        result:
          selection.tip === null ? null : renderTip(selection.tip, signals),
      };
    });
  }

  async function listView(
    client: TipClient | null,
    all: boolean,
  ): Promise<{ enabled: boolean; tips: TipListEntry[] }> {
    const enabled = await isEnabled();
    const tips = await evaluate(client, (state, signals, today, now) => {
      const retired = retireTips(state, signals, today, now);
      return {
        state: retired,
        result: listTips(retired, signals, today, all),
      };
    });
    return { enabled, tips };
  }

  async function recordTip(
    id: string,
    apply: typeof dismissTip,
  ): Promise<void> {
    if (findTip(id) === null) throw new UnknownTipError(id);
    const appVersion = await readAppVersion();
    await updateState((state) => apply(state, id, appVersion, Date.now()));
    bb.realtime.publish(TIPS_CHANGED_CHANNEL, {});
  }

  async function reset(): Promise<void> {
    await updateState(resetTips);
    bb.realtime.publish(TIPS_CHANGED_CHANNEL, {});
  }

  async function markObserved(observation: Observation): Promise<void> {
    if (knownObservations.has(observation)) return;
    knownObservations.add(observation);
    const now = Date.now();
    await updateState((state) => ({
      ...state,
      observed: recordObservation(state.observed, observation, now),
    }));
  }

  settings.onChange(() => {
    bb.realtime.publish(TIPS_CHANGED_CHANNEL, {});
  });

  bb.rpc.register(tipsRpcContract, {
    async current({ client }) {
      return { tip: await currentTip(client) };
    },
    async dismiss({ id }) {
      await recordTip(id, dismissTip);
      return { ok: true };
    },
    async act({ id }) {
      await recordTip(id, actOnTip);
      return { ok: true };
    },
    async list({ client, all }) {
      return listView(client, all);
    },
    async reset() {
      await reset();
      return { ok: true };
    },
  });

  function unknownTip(id: string): PluginCliError {
    return new PluginCliError(`Unknown tip: ${id}`, {
      code: "unknown_tip",
      hint: "Run `bb tips --all` for every tip id.",
    });
  }

  const listCommand = cliCommand({
    summary: "List the tips you could see now",
    description:
      "Lists tips that are eligible for this setup, highest priority first. The one marked showing today is on the New thread page. Tips that need a particular app (desktop, web, or mobile) are included.",
    options: LIST_OPTIONS,
    async run(input) {
      const view = await listView(null, input.options.all);
      return {
        exitCode: 0,
        stdout: input.options.json
          ? JSON.stringify(view)
          : formatList(view, input.options.all),
      };
    },
  });

  bb.cli.register(
    defineCli({
      name: "tips",
      summary: "List, dismiss, or reset bb tips",
      description:
        "bb shows at most one new tip a day on the New thread page. Dismissing a tip retires it for good, and a tip retires itself once you use its feature.",
      root: listCommand,
      commands: {
        list: listCommand,
        dismiss: cliCommand({
          summary: "Retire one tip for good",
          positionals: [
            {
              name: "id",
              description: "Tip id, as `bb tips --all` prints it",
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const id = input.positionals.id;
            try {
              await recordTip(id, dismissTip);
            } catch (error) {
              if (error instanceof UnknownTipError) throw unknownTip(id);
              throw error;
            }
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ ok: true, id })
                : `Dismissed ${id}.`,
            };
          },
        }),
        reset: cliCommand({
          summary: "Bring back every dismissed and retired tip",
          description:
            "Clears dismissals, retirements, and shown counts. What bb has learned about features you use is kept, so tips for those stay retired.",
          options: { json: JSON_OPTION },
          async run(input) {
            await reset();
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ ok: true })
                : "Tips reset.",
            };
          },
        }),
      },
    }),
  );

  bb.events.on("thread.idle", async () => {
    await markObserved("finishedThread");
  });

  bb.events.on("thread.created", async ({ thread }) => {
    if (thread.parentThreadId !== null) await markObserved("childThread");
  });

  bb.events.on("message.queued", async ({ entry }) => {
    if (isQueuedFollowUp(entry)) await markObserved("queuedFollowUp");
  });

  bb.events.on("turn.failed", async (event) => {
    if (!isRateLimitFailure(event)) return;
    const providerId =
      event.rateLimits?.providerId ??
      (await bb.sdk.threads
        .get({ threadId: event.threadId })
        .then((thread) => thread.providerId)
        .catch(() => null));
    if (providerId !== null && POOLED_PROVIDER_IDS.includes(providerId)) {
      await markObserved("rateLimited");
    }
  });
}
