import { Type } from "typebox";
import { Check } from "typebox/value";
import { agentSchema } from "./state.ts";
import type { Config } from "./index.ts";

export async function readDaemonDefinitions(): Promise<{ config: Config; prompts: Record<string, string> } | undefined> {
  const broker = process.env.PI_DESKTOP_BROKER_URL;

  if (!broker) return undefined;

  const response = await fetch(`${broker}/agent-definitions`, {
    headers: { Authorization: `Bearer ${process.env.PI_DESKTOP_BROKER_TOKEN || ""}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`Could not read daemon agent definitions: HTTP ${response.status}`);
  const result = await response.json();
  const schema = Type.Object({ data: Type.Object({ config: Type.Object({ agents: Type.Array(agentSchema) }), prompts: Type.Record(Type.String(), Type.String()) }) });

  if (!Check(schema, result)) throw new Error("Invalid daemon agent definitions");

  return result.data;
}
