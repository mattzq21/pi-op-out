import { Globe } from "lucide-solid";
import type { PluginModule } from "piop/plugin";
import { WebSearchSettings } from "./WebSearchSettings";

export const settings: PluginModule["settings"] = { label: "Web search", description: "Choose the OpenAI or Anthropic model that runs web searches.", icon: Globe, component: WebSearchSettings };
