export const ORCHESTRATION_STATUS_KEY = "pi-desktop-orchestration";

export function encodeOrchestrationValue(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeOrchestrationValue<T>(value: string): T {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64); const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
