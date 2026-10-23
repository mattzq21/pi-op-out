export function promptContext(tokens = {}, extra = {}) {
  return { systemPrompt: '', instructions: [], tools: [], skills: [], tokens: { system: 0, instructions: 0, tools: 0, skills: 0, ...tokens }, ...extra };
}
