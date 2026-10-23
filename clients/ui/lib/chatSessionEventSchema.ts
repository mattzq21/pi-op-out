import { z } from "zod";
import { assistantEventSchema, contentSchema, imageSchema, wireMessageSchema } from "./messageSchemas";

export const entrySchema = z.object({
  type: z.string(), id: z.string(), parentId: z.string().nullable().default(null),
  message: wireMessageSchema.optional(), customType: z.string().optional(), details: z.unknown().optional(),
  content: contentSchema.optional(), data: z.unknown().optional(), display: z.boolean().optional(),
  timestamp: z.string().optional(), tokensBefore: z.number().optional(),
});

export const pendingMessageSchema = z.object({
  id: z.string(), goalSubmissionId: z.string().optional(), message: z.string(), behavior: z.enum(["steer", "followUp"]),
  images: z.array(imageSchema.omit({ data: true }).extend({ data: z.string().optional() })).optional(), retry: z.boolean().optional(), recovered: z.boolean().optional(),
});

export const pendingMessagesSchema = z.array(pendingMessageSchema).optional();

export const chatSessionEventSchema = z.looseObject({
  type: z.string(),
  revision: z.string().optional().catch(undefined), previousRevision: z.string().nullable().optional(),
  sequence: z.number().optional().catch(undefined), epoch: z.string().optional(),
  viewers: z.number().optional(), isStreaming: z.boolean().optional(), isPaused: z.boolean().optional(), isPausing: z.boolean().optional(),
  method: z.string().optional(), statusKey: z.string().optional(), statusText: z.string().optional().catch(undefined),
  entry: entrySchema.optional(), message: wireMessageSchema.optional(), assistantMessageEvent: assistantEventSchema.optional(),
  parentToolCallId: z.string().optional(), toolCallId: z.string().optional(), toolName: z.string().optional(),
  isError: z.boolean().optional(), pendingMessages: pendingMessagesSchema,
  steering: z.array(z.unknown()).optional(), followUp: z.array(z.unknown()).optional(),
  aborted: z.boolean().optional(), errorMessage: z.string().optional(),
  attempt: z.number().optional(), level: z.string().optional().catch(undefined),
});

export type ChatSessionEvent = z.infer<typeof chatSessionEventSchema>;
