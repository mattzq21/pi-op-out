import { createContext, lazy, type Component } from "solid-js";
import { plugins } from ".";
import type { RpcCommand } from "../types";

export const PluginMessageContext = createContext<{ sessionId: () => string | undefined; command: (command: RpcCommand) => Promise<unknown> }>();

const renderers = new Map(plugins.flatMap(plugin => Object.entries(plugin.messages ?? {}).map(([type, load]) => [type, lazy(load)] as [string, Component<{ details: unknown }>])));

export const pluginMessageRenderer = (customType?: string) => customType === undefined ? undefined : renderers.get(customType);
