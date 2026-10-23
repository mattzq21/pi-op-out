export const debugFeatures = [
  { id: "contextBar", label: "Context bar" },
  { id: "contextInjections", label: "Context injections" },
  { id: "cacheHitRate", label: "Cache hit rate" },
  { id: "toolDetails", label: "Tool details" },
  { id: "mcpServers", label: "MCP server names" },
  { id: "sessionActions", label: "Session ID and file actions" },
  { id: "toastHistory", label: "Toast history" },
] as const;

export type DebugFeature = typeof debugFeatures[number]["id"];

/** Which debug features show now. All are off while debug mode is off. */
export type DebugView = Readonly<Record<DebugFeature, boolean>>;

export const noDebug: DebugView = Object.fromEntries(debugFeatures.map(feature => [feature.id, false])) as Record<DebugFeature, boolean>;

export function debugView(settings: { debugMode: boolean; debugFeaturesOff?: readonly string[] }): DebugView {
  if (!settings.debugMode) return noDebug;
  const off = new Set(settings.debugFeaturesOff ?? []);
  return Object.fromEntries(debugFeatures.map(feature => [feature.id, !off.has(feature.id)])) as Record<DebugFeature, boolean>;
}

