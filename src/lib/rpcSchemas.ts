import { z } from "zod";
import { imageSchema } from "./messageSchemas";

const optionalString = z.string().optional().catch(undefined);

export const rpcEventSchema = z.looseObject({
  type: z.string(), id: optionalString, method: optionalString,
  statusKey: optionalString, widgetKey: optionalString,
});

export const rpcCommandSchema = z.looseObject({
  type: z.string(), id: z.string().optional(), message: z.string().optional(), images: z.array(imageSchema).optional(),
});

const sessionIdentitySchema = z.object({ sessionId: optionalString, sessionFile: optionalString });

export const commandSessionSchema = sessionIdentitySchema.extend({
  state: sessionIdentitySchema.optional(), extensionState: z.array(rpcEventSchema).optional(),
}).catch({});

export const runtimeEventSchema = z.union([
  z.object({ runtimeId: z.string(), event: rpcEventSchema }),
  rpcEventSchema.transform(event => ({ runtimeId: undefined, event })),
]);

export const runtimeStderrSchema = z.union([
  z.string().transform(line => ({ runtimeId: undefined, line, global: true })),
  z.object({ runtimeId: optionalString, line: optionalString }).transform(output => ({ ...output, global: false })),
]);

export type CommandSession = z.infer<typeof commandSessionSchema>;
