export const DEFINED_AGENTS_STATUS_KEY = "pi-define-agents";

export function encodeAgentValue(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeAgentValue<T>(value: string): T {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = decodeBase64(base64);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
import { decodeBase64, encodeBase64 } from "./base64";
