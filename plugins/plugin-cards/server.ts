import {
  defineRpcContract,
  type BbPluginApi,
  type PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DIRECTIVE_ID,
  PLUGIN_ID_PATTERN,
  TOOL_NAME,
  pluginCardDirective,
} from "./shared.js";

const BUNDLED_MARKETPLACE = "bb-official";
const COMMUNITY_MARKETPLACE = "bb-community";

const TOOL_DESCRIPTION =
  "Show the user an inline card for an existing bb plugin. The card opens the plugin's detail page, where the user can review, enable, or install it. Pass the exact `pluginId` from `bb plugin search <terms> --json` or `bb plugin list --json`. This never installs or enables anything.";

const AGENT_INSTRUCTIONS = `When you recommend an existing bb plugin, call ${TOOL_NAME} with its pluginId and copy the returned \`::${DIRECTIVE_ID}\` line into your reply on its own line.`;

const pluginCardSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bundled") }).strict(),
  z.object({ kind: z.literal("community") }).strict(),
  z
    .object({ kind: z.literal("third-party"), marketplace: z.string() })
    .strict(),
  z.object({ kind: z.literal("local"), label: z.string() }).strict(),
]);

const pluginCardSchema = z
  .object({
    pluginId: z.string(),
    displayName: z.string(),
    description: z.string(),
    icon: z.string().nullable(),
    iconUrl: z.string().nullable(),
    iconTinted: z.boolean(),
    category: z.string().nullable(),
    source: pluginCardSourceSchema,
    installed: z.boolean(),
    enabled: z.boolean(),
    compatible: z.boolean(),
    incompatibleReason: z.string().nullable(),
  })
  .strict();

export type PluginCard = z.infer<typeof pluginCardSchema>;
export type PluginCardSource = z.infer<typeof pluginCardSourceSchema>;

type PluginCardLookup =
  | { kind: "found"; card: PluginCard }
  | { kind: "not-found"; pluginId: string };

export const pluginCardsRpcContract = defineRpcContract({
  getPluginCard: {
    input: z.object({ pluginId: z.string().trim().min(1) }).strict(),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("found"), card: pluginCardSchema }).strict(),
      z.object({ kind: z.literal("not-found"), pluginId: z.string() }).strict(),
    ]),
  },
});

function catalogSource(marketplace: string, displayName: string) {
  if (marketplace === BUNDLED_MARKETPLACE) return { kind: "bundled" } as const;
  if (marketplace === COMMUNITY_MARKETPLACE) {
    return { kind: "community" } as const;
  }
  return { kind: "third-party", marketplace: displayName } as const;
}

export async function lookupPluginCard(
  bb: BbPluginApi,
  rawPluginId: string,
): Promise<PluginCardLookup> {
  const pluginId = rawPluginId.trim();
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    return { kind: "not-found", pluginId };
  }
  const [{ results }, { plugins }] = await Promise.all([
    bb.sdk.plugins.catalog.search({ query: pluginId }),
    bb.sdk.plugins.list(),
  ]);
  const entry =
    results.find((result) => result.pluginId === pluginId) ??
    results.find((result) => result.entryId === pluginId);
  const installed = plugins.find(
    (plugin) => plugin.id === (entry?.pluginId ?? pluginId),
  );
  if (entry !== undefined) {
    return {
      kind: "found",
      card: {
        pluginId: entry.pluginId,
        displayName: entry.displayName,
        description: entry.description,
        icon: entry.icon,
        iconUrl: entry.iconUrl,
        iconTinted: entry.iconTinted,
        category: entry.category ?? null,
        source: catalogSource(entry.marketplace, entry.marketplaceDisplayName),
        installed: installed !== undefined,
        enabled: installed?.enabled ?? false,
        compatible: entry.compatible,
        incompatibleReason: entry.incompatibleReason,
      },
    };
  }
  if (installed !== undefined) {
    return {
      kind: "found",
      card: {
        pluginId: installed.id,
        displayName: installed.name ?? installed.id,
        description: installed.description ?? "",
        icon: installed.icon,
        iconUrl: installed.iconUrl,
        iconTinted: false,
        category: installed.category ?? null,
        source: { kind: "local", label: installed.sourceDisplay },
        installed: true,
        enabled: installed.enabled,
        compatible: true,
        incompatibleReason: null,
      },
    };
  }
  return { kind: "not-found", pluginId };
}

function errorResult(message: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(pluginCardsRpcContract, {
    getPluginCard: ({ pluginId }) => lookupPluginCard(bb, pluginId),
  });

  bb.agents.registerTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    presentation: {
      label: { pending: "Finding plugin", completed: "Showed plugin card" },
      icon: { glyph: "Puzzle" },
    },
    parameters: z.object({ pluginId: z.string() }).strict(),
    async execute({ pluginId }) {
      const lookup = await lookupPluginCard(bb, pluginId);
      if (lookup.kind === "not-found") {
        return errorResult(
          `No installed or store-listed plugin has the id ${JSON.stringify(lookup.pluginId)}. Run \`bb plugin search <terms> --json\` and pass a result's exact "pluginId"; do not guess ids.`,
        );
      }
      return [
        `Copy this line verbatim into your reply as a standalone line where the card for ${lookup.card.displayName} should appear:`,
        "",
        pluginCardDirective(lookup.card.pluginId),
      ].join("\n");
    },
  });

  bb.agents.configure(() => ({
    tools: [TOOL_NAME],
    skills: [],
    instructions: AGENT_INSTRUCTIONS,
  }));
}
