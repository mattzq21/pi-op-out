import type { PromptContextInfo } from "../types";

export function separatePromptInstructions(context: PromptContextInfo): PromptContextInfo {
  if (typeof context.systemPrompt !== "string") return context;
  const blocks = [...context.systemPrompt.matchAll(/<(instructions|INSTRUCTIONS|cwd)>\s*([\s\S]*?)\s*<\/\1>/g)];
  if (!blocks.length) return context;
  const instructions = [...(context.instructions ?? [])];
  let systemPrompt = context.systemPrompt;
  let movedTokens = 0;
  for (const [block, tag, content] of blocks) {
    systemPrompt = systemPrompt.replace(block, "");
    instructions.push({ path: tag === "cwd" ? "Working directory" : "Agent instructions", content });
    movedTokens += Math.ceil(block.length / 4);
  }
  const systemTokens = Number(context.tokens?.system) || 0;
  const moved = Math.min(systemTokens, movedTokens);
  return {
    ...context,
    systemPrompt: systemPrompt.replace(/\n{3,}/g, "\n\n").trim(),
    instructions,
    tokens: { ...context.tokens, system: systemTokens - moved, instructions: (Number(context.tokens?.instructions) || 0) + moved },
  };
}
