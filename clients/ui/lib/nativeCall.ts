import { z } from "zod";
import type { CommandInput, CommandName, CommandResult, InnerProtocolCommand } from "../../../protocol/commands";
import type { NativeArguments } from "./transportSchemas";
import { invoke } from "./platform";
import type { NativeCommand } from "./desktopCommands";

export type NativeCall = typeof nativeCall;

// A daemon command, checked by the shared command table, or a command of the app itself with the schema of its answer.
export function nativeCall<Name extends CommandName>(command: Name, args?: CommandInput<Name>): Promise<CommandResult<Name>>;
export function nativeCall<Name extends InnerProtocolCommand, S extends z.ZodType>(command: Name, args: CommandInput<Name>, schema: S): Promise<z.output<S>>;
export function nativeCall<S extends z.ZodType>(command: NativeCommand, args: NativeArguments | undefined, schema: S): Promise<z.output<S>>;
export async function nativeCall(command: string, args?: unknown, schema?: z.ZodType) {
  return invoke(command as NativeCommand, args as NativeArguments, schema as z.ZodType);
}
