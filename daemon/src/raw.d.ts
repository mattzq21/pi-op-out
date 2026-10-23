declare module '*?raw' {
  const content: string;
  export default content;
}

/** The agent definition loader of the piop-define-agents extension. The daemon build resolves it to extensions/piop-define-agents/daemon-loader.ts. */
declare module 'piop-agent-loader' {
  export function loadAgentDefinitions(request: { settings: any; initial: boolean }): Promise<{ config: any; prompts: Record<string, string>; configPath: string }>;
}

declare const __PIOP_DEVELOPMENT__: boolean;
declare const __PIOP_BUILD_ID__: string;
declare const __PIOP_PROJECT_DIR__: string;
