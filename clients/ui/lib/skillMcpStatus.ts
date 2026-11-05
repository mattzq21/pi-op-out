import { z } from "zod";

const statusSchema = z.array(z.object({ state: z.enum(["connecting", "connected"]) }));

export function skillMcpConnecting(value?: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(value ?? "[]"); } catch { return false; }
  const status = statusSchema.safeParse(parsed);
  return status.success && status.data.some(server => server.state === "connecting");
}
