import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const TURN_CONTEXT_TOOL_NAME = "claude_code_turn_context";
export const TURN_CONTEXT_PROTOCOL = 3;
export const TURN_CONTEXT_TIMEOUT_MS = 20_000;
export const FRESH_SESSION_INIT_TIMEOUT_MS = 30_000;
export const MAX_TURN_CONTEXT_REPORTS = 16;
export const MAX_RETAINED_TURN_CONTEXTS = 64;
export const FRESH_SESSION_TITLE = "BB OptChat turn";
export const FRESH_SESSION_SEED_TITLE = "BB OptChat seed";
export const FRESH_SESSION_SEED_PROMPT =
  "This opening exchange only prepares the session; the conversation starts with the next message. Reply with only: Ready.";
export const FRESH_SESSION_SEED_TIMEOUT_MS = 60_000;
export const FRESH_SESSION_SEED_MAX_AGE_MS = 60 * 60_000;

const turnContextSchema = z.object({
  session: z.literal("fresh"),
  sessionId: z.string().uuid(),
  systemPrompt: z.string(),
  input: z.string().min(1),
});

const ackSchema = z.string().min(1).optional();

const freshAnswerSchema = turnContextSchema.extend({ ack: ackSchema });

const residentAnswerSchema = z.object({ ack: ackSchema }).strict();

export type TurnContext = z.infer<typeof turnContextSchema>;

export type TurnContextAnswer =
  | { ok: true; ack: string | null; context: TurnContext | null }
  | { ok: false; error: string };

export interface TurnContextReport {
  requestId: string;
  offeredSessionId: string | null;
  outcome: "fresh" | "resident";
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
    return { ok: false, error: result.content || "the tool call failed" };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.content);
  } catch {
    return { ok: false, error: "the answer is not JSON" };
  }
  if (typeof value === "object" && value !== null && "session" in value) {
    const fresh = freshAnswerSchema.safeParse(value);
    if (!fresh.success) {
      return { ok: false, error: "the fresh session answer is malformed" };
    }
    const { ack, ...context } = fresh.data;
    return { ok: true, ack: ack ?? null, context };
  }
  const resident = residentAnswerSchema.safeParse(value);
  if (!resident.success) {
    return { ok: false, error: "the answer is malformed" };
  }
  return { ok: true, ack: resident.data.ack ?? null, context: null };
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
