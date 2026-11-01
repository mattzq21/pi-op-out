declare module '*?raw' {
  const content: string;
  export default content;
}

declare module 'piop-agent-loader' {
  export function loadAgentDefinitions(request: { settings: any; initial: boolean; project?: { cwd: string; global: any } }): Promise<{ config: any; prompts: Record<string, string> }>;
  export function moveAgent(request: { settings: any; global: any; cwd: string; agent: string; revision: string; to: string }): Promise<{ revision: string; warnings: string[]; definitions: { config: any; prompts: Record<string, string> } }>;
  export function saveAgentDefinitions(request: { settings: any; configuration: unknown; project?: { cwd: string; global: any } }): Promise<{ revision: string; warnings: string[]; definitions: { config: any; prompts: Record<string, string> } }>;
}

declare const __PIOP_DEVELOPMENT__: boolean;
declare const __PIOP_BUILD_ID__: string;
declare const __PIOP_PROJECT_DIR__: string;
declare const __PIOP_UNUSED_STOP_MS__: number;
