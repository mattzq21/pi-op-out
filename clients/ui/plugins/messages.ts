import { createContext } from "solid-js";
import type { RpcCommand } from "../types";

export const PluginMessageContext = createContext<{ sessionId: () => string | undefined; command: (command: RpcCommand) => Promise<unknown> }>();
