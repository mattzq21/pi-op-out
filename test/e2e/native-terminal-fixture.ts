import { z, type JSONType } from "zod";
import type { NativeArguments } from "../../clients/ui/lib/transportSchemas";

const requestSchema = z.object({ action: z.string(), hostId: z.string().default("local"), sessionKey: z.string().default(""), sharedTerminalId: z.string().default("") });

const terminals = new Map<string, { id: string; hostId: string; sessionKey: string; output: string; outputEnd: number; generation: string; owned: boolean; started: boolean; exited: boolean; inputDraft: string }>();

let fixture = "";

export function mockSharedTerminal(args: NativeArguments | undefined, responses: Record<string, JSONType>): JSONType {
  const nextFixture = z.string().parse(responses.__terminalFixture);

  if (fixture !== nextFixture) { terminals.clear(); fixture = nextFixture; }

  const request = requestSchema.parse(args);
  const key = `${request.hostId}:${request.sharedTerminalId}`;

  if (request.action === "list") return [...terminals.values()].filter(terminal => terminal.sessionKey === request.sessionKey && terminal.hostId === request.hostId);

  if (request.action === "start" && !terminals.has(key)) {
    terminals.set(key, { id: request.sharedTerminalId, hostId: request.hostId, sessionKey: request.sessionKey, generation: "e2e", output: "", outputEnd: 0, inputDraft: "", owned: true, started: true, exited: false });
  }

  if (request.action === "close") terminals.delete(key);
  const terminal = terminals.get(key);

  if (request.action === "reassign" && terminal) terminal.sessionKey = request.sessionKey;

  return {};
}
