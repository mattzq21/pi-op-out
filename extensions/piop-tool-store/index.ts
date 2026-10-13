import { Type } from "typebox";
import { Check } from "typebox/value";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile as readRecord } from "../app-settings.cjs";
import type { ToolLists, ToolStore } from "./interface.ts";

/** The lists are shared by every Pi session in this process. */
const key = Symbol.for("piop.tool-store");

const listsSchema = Type.Object({ enabledTools: Type.Array(Type.String()), registeredTools: Type.Array(Type.String()) }, { additionalProperties: false });

function parse(value: unknown): ToolLists {
  if (!Check(listsSchema, value)) throw new Error("Invalid tool lists");
  const registered = new Set(value.registeredTools);
  const unknown = value.enabledTools.find(name => !registered.has(name));

  if (unknown !== undefined) throw new Error(`Enabled tool ${unknown} is not registered`);

  return structuredClone(value);
}

function stored(): ToolLists | undefined { return Object.getOwnPropertyDescriptor(globalThis, key)?.value; }

function save(lists: ToolLists) { Object.defineProperty(globalThis, key, { value: lists, writable: true, configurable: true, enumerable: true }); }

function current(): ToolLists {
  const lists = stored();

  if (!lists) throw new Error("Tool lists are unavailable");

  return lists;
}

const store: ToolStore = {
  lists: () => structuredClone(current()),
  replace(value) {
    const next = parse(value);
    const changed = JSON.stringify(next) !== JSON.stringify(current());
    save(next);

    return changed;
  },
};

export default function toolStore(pi: ExtensionAPI) {
  if (!stored()) save(parse(readRecord(process.env.PIOP_TOOL_STORE_PATH || join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "tool-store.json"))));
  const unsubscribe = pi.events.on("piop:tool-store", request => { request.store = store; });
  pi.on("session_shutdown", () => { unsubscribe(); });
}
