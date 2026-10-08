import { z } from "zod";
import { rpcCommandSchema } from "./rpcSchemas";

export const nativeArgumentsSchema = z.looseObject({
  runtimeId: z.string().optional(), command: rpcCommandSchema.optional(),
  terminalId: z.string().optional(), url: z.string().optional(), clientId: z.string().optional(),
});

export type NativeArguments = z.infer<typeof nativeArgumentsSchema>;

export const jsonResultSchema = z.json().optional();

export const remotePacketSchema = z.object({
  type: z.string().optional(), protocol: z.number().optional(), backend: z.string().optional(),
  event: z.string().optional(), payload: jsonResultSchema, id: z.union([z.string(), z.number()]).optional(),
  error: z.string().optional(), result: jsonResultSchema,
});

export type RemotePacket = z.infer<typeof remotePacketSchema>;
