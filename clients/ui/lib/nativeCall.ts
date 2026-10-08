import { emit as emitNativeEvent } from "@tauri-apps/api/event";
import { z, type JSONType } from "zod";
import { rpcEventSchema } from "./rpcSchemas";
import { jsonResultSchema, type NativeArguments } from "./transportSchemas";
import { invoke } from "./platform";
import { mockSharedTerminal } from "../../../test/e2e/native-terminal-fixture";

export type NativeCall = typeof nativeCall;

const mockMetadataSchema = z.object({ error: z.string().optional(), events: z.array(rpcEventSchema).optional() }).catch({});

function responseKey(command: string, args?: NativeArguments) {
  if (command === "shared_terminal" || command === "recover_missing_session") return command + ":" + String(args?.action);

  return command === "pi_command" ? command + ":" + String(args?.command?.type) : command;
}

async function mockResponse(command: string, response: JSONType, args: NativeArguments | undefined, responses: Record<string, JSONType>) {
  const metadata = mockMetadataSchema.parse(response);

  if (metadata.error) throw new Error(metadata.error);

  if (command === "shared_terminal") return mockSharedTerminal(args, responses);

  if (command === "start_pi" && metadata.events) {
    await Promise.all(metadata.events.map(event => emitNativeEvent("pi://event", { runtimeId: args?.runtimeId, event })));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  return response;
}

export function nativeCall<S extends z.ZodType>(command: string, args: NativeArguments | undefined, schema: S): Promise<z.output<S>>;
export function nativeCall(command: string, args?: NativeArguments): Promise<JSONType | undefined>;
export async function nativeCall(command: string, args?: NativeArguments, schema: z.ZodType = jsonResultSchema) {
  if (import.meta.env.MODE !== "e2e") return invoke(command, args, schema);
  const key = responseKey(command, args);
  const responseField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-responses");
  const callField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-calls");
  const responses = z.record(z.string(), z.json()).parse(JSON.parse(responseField?.value || "{}"));

  if (callField?.value) {
    const calls = z.array(z.json()).parse(JSON.parse(callField.value));
    callField.value = JSON.stringify([...calls, { command, args, mocked: key in responses }]);
  }

  if (!(key in responses)) return invoke(command, args, schema);

  return schema.parse(await mockResponse(command, responses[key], args, responses));
}
