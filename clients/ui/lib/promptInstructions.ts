import type { PromptContextInfo } from "../types";

function moveInstruction(instructions: PromptContextInfo["instructions"], known: Set<string>, tag: string, content: string, length: number) {
  const path = tag === "cwd" ? "Working directory" : "Agent instructions";
  const key = JSON.stringify([path, content]);

  if (known.has(key)) return 0;
  known.add(key);
  instructions.push({ path, content });

  return Math.ceil(length / 4);
}

function instructionBlocks(source: string) {
  const openings = /<(instructions|INSTRUCTIONS|agent_instructions|cwd)>/g;
  const missing = new Set<string>();
  const blocks = [];

  for (let match = openings.exec(source); match; match = openings.exec(source)) {
    const tag = match[1];

    if (missing.has(tag)) continue;
    const closing = `</${tag}>`;
    const end = source.indexOf(closing, openings.lastIndex);

    if (end < 0) { missing.add(tag); continue; }

    blocks.push({ start: match.index, end: end + closing.length, tag, content: source.slice(openings.lastIndex, end).trim() });
    openings.lastIndex = end + closing.length;
  }

  return blocks;
}

export function separatePromptInstructions(context: PromptContextInfo): PromptContextInfo {
  if (!context.systemPrompt) return context;
  const blocks = instructionBlocks(context.systemPrompt);

  if (!blocks.length) return context;
  const instructions = [...(context.instructions ?? [])];
  const known = new Set(instructions.map(item => JSON.stringify([item.path, item.content.trim()])));
  const fragments = [];
  let cursor = 0;
  let movedTokens = 0;

  for (const block of blocks) {
    fragments.push(context.systemPrompt.slice(cursor, block.start));
    cursor = block.end;
    movedTokens += moveInstruction(instructions, known, block.tag, block.content, block.end - block.start);
  }

  fragments.push(context.systemPrompt.slice(cursor));
  const systemTokens = Number(context.tokens?.system) || 0;
  const moved = Math.min(systemTokens, movedTokens);

  return {
    ...context,
    systemPrompt: fragments.join("").replace(/\n{3,}/g, "\n\n").trim(),
    instructions,
    tokens: { ...context.tokens, system: systemTokens - moved, instructions: (Number(context.tokens?.instructions) || 0) + moved },
  };
}
