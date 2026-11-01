declare module '*?raw' {
  const content: string;
  export default content;
}

declare module 'piop-agent-loader' {
  export function loadAgentDefinitions(request: { settings: any; initial: boolean }): Promise<{ config: any; prompts: Record<string, string> }>;
  export function saveAgentDefinitions(request: { settings: any; configuration: unknown }): Promise<{ revision: string; warnings: string[]; definitions: { config: any; prompts: Record<string, string> } }>;
}

declare const __PIOP_DEVELOPMENT__: boolean;
declare const __PIOP_BUILD_ID__: string;
declare const __PIOP_PROJECT_DIR__: string;
