declare module '*?raw' {
  const content: string;
  export default content;
}

declare module '*?pi-extension' {
  const content: string;
  export default content;
}

declare module '*?node-program' {
  const content: string;
  export default content;
}

declare module 'piop-agent-loader' {
  export function loadAgentDefinitions(request: { settings: any; initial: boolean; project?: { cwd: string; global: any } }): Promise<{ config: any; prompts: Record<string, string> }>;
  export function moveAgent(request: { settings: any; global: any; agent: string; revision: string; from: string | null; to: string | null }): Promise<{ revision: string; warnings: string[]; definitions: { config: any; prompts: Record<string, string> } }>;
  export function saveAgentDefinitions(request: { settings: any; configuration: unknown; project?: { cwd: string; global: any } }): Promise<{ revision: string; warnings: string[]; definitions: { config: any; prompts: Record<string, string> } }>;
}

declare const __PIOP_DEVELOPMENT__: boolean;
declare const __PIOP_BUILD_ID__: string;
declare const __PIOP_PROJECT_DIR__: string;
declare const __PIOP_UNUSED_STOP_MS__: number;

// The built-in plugins: the folders in plugins/, built. See daemonImports().
declare module 'piop-builtin-plugins' {
  const plugins: Array<{ manifest: string; extension?: string; client?: string }>;
  export default plugins;
}
