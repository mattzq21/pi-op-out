import { z } from "zod";

export function validItems<T extends z.ZodType>(schema: T) {
  return z.array(schema.optional().catch(undefined)).transform(items => items.filter(item => item !== undefined));
}

export const stringsSchema = validItems(z.string());

export const imageSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), name: z.string().optional() });

const textSchema = z.object({ type: z.literal("text"), text: z.string() });

const contentPartSchema = z.union([
  imageSchema,
  textSchema,
  z.object({ type: z.literal("thinking"), thinking: z.string() }),
  z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.json()).default({}), partialArgs: z.string().optional() }),
]);

export const contentSchema = z.union([z.string(), z.array(contentPartSchema)]);

const tokensSchema = z.object({
  system: z.coerce.number().catch(0), instructions: z.coerce.number().catch(0),
  tools: z.coerce.number().catch(0), skills: z.coerce.number().catch(0),
}).catch({ system: 0, instructions: 0, tools: 0, skills: 0 });

const skillSchema = z.object({
  filePath: z.string(), name: z.string().optional().catch(undefined), description: z.string().catch(""),
  id: z.string().optional(), content: z.string().optional(),
}).transform(skill => ({ ...skill, name: skill.name ?? skill.filePath }));

export const promptContextSchema = z.object({
  userTimestamp: z.number().optional(),
  agentNotificationId: z.string().optional(),
  inputTokens: z.number().int().positive().optional(),
  systemPrompt: z.string().catch(""),
  instructions: validItems(z.object({ path: z.string(), content: z.string().catch("") })).catch([]),
  tools: validItems(z.object({ name: z.string(), description: z.string().catch(""), parameters: z.unknown().optional(), codemode: z.boolean().optional() })).catch([]),
  skills: validItems(skillSchema).catch([]),
  userInvokedSkills: validItems(skillSchema).optional().catch(undefined),
  skillTokens: z.object({ defined: z.number(), invoked: z.number() }).optional().catch(undefined),
  tokens: tokensSchema,
});

export const toolPathSchema = z.object({ toolCallId: z.string(), path: z.string(), absolutePath: z.string(), canonicalPath: z.string() });

const nestedCallsSchema = z.object({
  calls: z.array(z.object({
    id: z.string(), name: z.string(), arguments: z.record(z.string(), z.json()).optional(),
    argumentsBytes: z.number().optional(), status: z.enum(["ok", "error", "unfinished"]),
    durationMs: z.number().optional(), error: z.string().optional(),
  })),
  complete: z.boolean(),
});

export const usageSchema = z.looseObject({
  input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(),
  reasoning: z.number().optional(), totalTokens: z.number(),
});

export const wireMessageSchema = z.looseObject({
  id: z.string().optional().catch(undefined),
  role: z.enum(["user", "assistant", "tool", "system", "custom", "toolResult"]).optional(),
  content: contentSchema.catch(""),
  timestamp: z.union([z.string(), z.number()]).optional().catch(undefined),
  completedAt: z.number().optional(), customType: z.string().optional(), display: z.boolean().optional(),
  isError: z.boolean().optional(), model: z.string().optional(), streaming: z.boolean().optional(),
  stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]).optional(),
  errorMessage: z.string().optional(), toolName: z.string().optional(), toolCallId: z.string().optional(),
  toolInput: z.unknown().optional(), details: z.unknown().optional(),
  promptContext: promptContextSchema.optional(), contextCheckpoint: z.boolean().optional(),
  nestedCalls: nestedCallsSchema.optional(),
  usage: usageSchema.optional(),
  deferredWork: z.object({ reasoningOnly: z.boolean(), usage: usageSchema.optional(), firstUsage: usageSchema.optional() }).optional(),
  deferredToolPayload: z.string().optional(), toolPayloadLoaded: z.boolean().optional(),
  toolPayloadVersion: z.number().optional(), loadedToolPayloadVersion: z.number().optional(),
  deliveryBehavior: z.enum(["steer", "followUp"]).optional(),
});

export type WireMessage = z.infer<typeof wireMessageSchema>;

export const resumeContentSchema = z.union([
  z.string(),
  validItems(textSchema).transform(parts => parts.map(part => part.text).join("\n")),
]).catch("");

export const resumeMarkerSchema = z.object({ message: z.string() });

export const pauseStateSchema = z.object({ isPaused: z.boolean() });

export const assistantEventSchema = z.object({
  type: z.string().optional(), contentIndex: z.number().int().nonnegative().optional().catch(undefined),
  delta: z.string().optional(), content: z.string().optional(), id: z.string().optional(), toolName: z.string().optional(),
  toolCall: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
});

export type AssistantEvent = z.infer<typeof assistantEventSchema>;
