import { z, type JSONType } from "zod";
import { jsonResultSchema, type NativeArguments } from "./transportSchemas";
import { invoke } from "./platform";

export type NativeCall = typeof nativeCall;

export function nativeCall<S extends z.ZodType>(command: string, args: NativeArguments | undefined, schema: S): Promise<z.output<S>>;
export function nativeCall(command: string, args?: NativeArguments): Promise<JSONType | undefined>;
export async function nativeCall(command: string, args?: NativeArguments, schema: z.ZodType = jsonResultSchema) {
  return invoke(command, args, schema);
}
