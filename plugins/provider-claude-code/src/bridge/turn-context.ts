import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const TURN_CONTEXT_TOOL_NAME = "claude_code_turn_context";
export const TURN_CONTEXT_PROTOCOL = 3;
export const TURN_CONTEXT_TIMEOUT_MS = 20_000;
export const FRESH_SESSION_INIT_TIMEOUT_MS = 30_000;
export const MAX_TURN_CONTEXT_REPORTS = 16;
export const MAX_RETAINED_TURN_CONTEXTS = 64;

const turnContextSchema = z.object({
  session: z.literal("fresh"),
  sessionId: z.string().uuid(),
  systemPrompt: z.string(),
  input: z.string().min(1),
});

const turnContextAckSchema = z.object({ ack: z.string().min(1) });

export type TurnContext = z.infer<typeof turnContextSchema>;

export interface TurnContextAnswer {
  ack: string | null;
  context: TurnContext | null;
}

export interface TurnContextReport {
  requestId: string;
  offeredSessionId: string | null;
  outcome: "fresh" | "resident" | "failed";
  sessionId: string | null;
}

export type SystemPrompt = Exclude<Options["systemPrompt"], undefined>;

export function hasTurnContextTool(
  dynamicTools: readonly DynamicTool[] | undefined,
): boolean {
  return (dynamicTools ?? []).some(
    (tool) => tool.name === TURN_CONTEXT_TOOL_NAME,
  );
}

export function withoutTurnContextTool(
  dynamicTools: readonly DynamicTool[],
): DynamicTool[] {
  return dynamicTools.filter((tool) => tool.name !== TURN_CONTEXT_TOOL_NAME);
}

export function parseTurnContext(result: {
  content: string;
  isError?: boolean;
}): TurnContextAnswer {
  if (result.isError === true) {
    return { ack: null, context: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.content);
  } catch {
    return { ack: null, context: null };
  }
  const ack = turnContextAckSchema.safeParse(value);
  const context = turnContextSchema.safeParse(value);
  return {
    ack: ack.success ? ack.data.ack : null,
    context: context.success ? context.data : null,
  };
}

export function acknowledgeReports(
  reports: readonly TurnContextReport[],
  ack: string | null,
): TurnContextReport[] {
  const acknowledged = reports.findIndex((report) => report.requestId === ack);
  return acknowledged === -1 ? [...reports] : reports.slice(acknowledged + 1);
}

export function extendSystemPrompt(
  base: SystemPrompt,
  extra: string,
): SystemPrompt {
  if (extra.length === 0) {
    return base;
  }
  if (typeof base === "string") {
    return `${base}\n\n${extra}`;
  }
  if (Array.isArray(base)) {
    return [...base, extra];
  }
  return {
    ...base,
    append:
      base.append && base.append.length > 0
        ? `${base.append}\n\n${extra}`
        : extra,
  };
}
