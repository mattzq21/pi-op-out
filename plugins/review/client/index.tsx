import { ClipboardCheck } from "lucide-solid";
import type { PluginModule } from "piop/plugin";
import { ReviewLink } from "./ReviewLink";
import { ReviewSettings } from "./ReviewSettings";

export const settings: PluginModule["settings"] = { label: "Review", description: "Choose the agent that runs /review.", icon: ClipboardCheck, component: ReviewSettings };

export const messages: PluginModule["messages"] = { "piop-review-link": ReviewLink };
