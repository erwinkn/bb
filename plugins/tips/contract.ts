import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const tipClientSchema = z
  .object({
    surface: z.enum(["desktop", "web", "mobile-app", "mobile-web"]),
    os: z.enum(["macos", "windows", "linux", "ios", "android", "unknown"]),
  })
  .strict();
export type TipClient = z.infer<typeof tipClientSchema>;

export const tipActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prompt"),
      label: z.string().min(1),
      prompt: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("route"),
      label: z.string().min(1),
      path: z.string().startsWith("/"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      label: z.string().min(1),
      commandId: z.enum(["palette.open", "thread.search"]),
    })
    .strict(),
]);
export type TipAction = z.infer<typeof tipActionSchema>;

export const tipViewSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string().min(1),
    action: tipActionSchema.nullable(),
  })
  .strict();
export type TipView = z.infer<typeof tipViewSchema>;

export const tipStatusSchema = z.enum([
  "current",
  "eligible",
  "not-applicable",
  "dismissed",
  "retired",
  "held",
]);
export type TipStatus = z.infer<typeof tipStatusSchema>;

export const tipRetiredReasonSchema = z.enum(["used", "acted", "seen"]);
export type TipRetiredReason = z.infer<typeof tipRetiredReasonSchema>;

export const tipListEntrySchema = tipViewSchema
  .extend({
    status: tipStatusSchema,
    shownDays: z.number().int().nonnegative(),
    dismissed: z.boolean(),
    acted: z.boolean(),
    retiredReason: tipRetiredReasonSchema.nullable(),
  })
  .strict();
export type TipListEntry = z.infer<typeof tipListEntrySchema>;

const tipIdInputSchema = z.object({ id: z.string().min(1).max(64) }).strict();
const okSchema = z.object({ ok: z.literal(true) }).strict();

export const tipsRpcContract = defineRpcContract({
  current: {
    input: z.object({ client: tipClientSchema }).strict(),
    output: z.object({ tip: tipViewSchema.nullable() }).strict(),
  },
  dismiss: { input: tipIdInputSchema, output: okSchema },
  act: { input: tipIdInputSchema, output: okSchema },
  list: {
    input: z
      .object({ client: tipClientSchema.nullable(), all: z.boolean() })
      .strict(),
    output: z
      .object({ enabled: z.boolean(), tips: z.array(tipListEntrySchema) })
      .strict(),
  },
  reset: { input: z.null(), output: okSchema },
});

export const TIPS_CHANGED_CHANNEL = "tips-changed";
