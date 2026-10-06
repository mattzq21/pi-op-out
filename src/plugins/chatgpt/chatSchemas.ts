import { z } from "zod";
import { ownershipSchema } from "../ownership";

export const regularChatSchema = z.object({
  id: z.string(), title: z.string(), model: z.string(), updatedAt: z.number(),
  thinkingEffort: z.string().optional(), versionId: z.string().optional(),
  status: z.enum(["idle", "streaming", "stopping", "complete", "stopped", "error"]),
  contextSource: z.string().optional(), error: z.string().optional(), submissionId: z.string().optional(),
  acceptedSubmissionIds: z.array(z.string()).default([]),
  messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), text: z.string() })).default([]),
  ownership: ownershipSchema.optional(),
});

export const chatModelsSchema = z.array(z.object({
  id: z.string(), name: z.string(),
  presets: z.array(z.object({ name: z.string(), model: z.string(), thinkingEffort: z.string().optional() })).min(1),
}));

export const chatAccountsSchema = z.array(z.object({ id: z.string(), name: z.string(), configured: z.boolean() }));

export const chatRequirementsSchema = z.object({
  ticket: z.string(),
  proofofwork: z.object({ required: z.boolean(), seed: z.string().optional(), difficulty: z.string().optional() }).optional(),
  turnstile: z.object({ required: z.boolean(), dx: z.string().optional() }).optional(),
});

export type RegularChat = z.infer<typeof regularChatSchema>;
