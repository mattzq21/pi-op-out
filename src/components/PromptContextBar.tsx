import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal } from "solid-js";
import { type CSSProperties } from "../lib/solid";

import type { PromptContextInfo } from "../types";

type Section = "system" | "instructions" | "tools" | "skills";

function shares(values: { system: number; instructions: number; tools: number; skills: number }) {
  const keys = ["system", "instructions", "tools", "skills"] as const;
  const total = keys.reduce((sum, key) => sum + values[key], 0);
  if (!total) return { system: 0, instructions: 0, tools: 0, skills: 0 };
  const exact = keys.map((key) => values[key] / total * 100);
  const result = exact.map(Math.floor); let remainder = 100 - result.reduce((sum, value) => sum + value, 0);
  for (const index of exact.map((value, index) => ({ index, fraction: value - result[index] })).sort((a, b) => b.fraction - a.fraction).map(({ index }) => index)) {
    if (!remainder) break; result[index] += 1; remainder -= 1;
  }
  return { system: result[0], instructions: result[1], tools: result[2], skills: result[3] };
}

function contextTokens(context: PromptContextInfo) {
  const tokens = context?.tokens && typeof context.tokens === "object" ? { system: Number((context.tokens as Record<string, unknown>).system) || 0, instructions: Number((context.tokens as Record<string, unknown>).instructions) || 0, tools: Number((context.tokens as Record<string, unknown>).tools) || 0, skills: Number((context.tokens as Record<string, unknown>).skills) || 0 } : { system: 0, instructions: 0, tools: 0, skills: 0 };
  return tokens;
}

function contextSections(context: PromptContextInfo) {
  const systemPrompt = typeof context?.systemPrompt === "string" ? context.systemPrompt : "";
  const instructions = Array.isArray(context?.instructions) ? context.instructions.filter((item): item is NonNullable<typeof item> => Boolean(item) && typeof (item as { path?: unknown }).path === "string") : [];
  const tools = Array.isArray(context?.tools) ? context.tools.filter((item): item is NonNullable<typeof item> => Boolean(item) && typeof (item as { name?: unknown }).name === "string") : [];
  const skills = Array.isArray(context?.skills) ? context.skills.filter((item): item is NonNullable<typeof item> => Boolean(item) && typeof (item as { filePath?: unknown }).filePath === "string") : [];
  return { systemPrompt, instructions, tools, skills };
}

export const PromptContextBar = function PromptContextBar(componentProps: { context: PromptContextInfo }) {
  const [active, setActive] = createSignal<Section>();
  const sections = createMemo(() => (contextSections(componentProps.context)));
  const percent = createMemo(() => (shares(contextTokens(componentProps.context))));
  const wheelStyle = createMemo(() => ({ "--prompt-system": `${percent().system}%`, "--prompt-instructions": `${percent().system + percent().instructions}%`, "--prompt-tools": `${percent().system + percent().instructions + percent().tools}%` } as CSSProperties));
  const toggle = (section: Section) => setActive((current) => current === section ? undefined : section);
  const renderPromptContextContent = () => (active() && <div class={`prompt-context-content ${(active())!}`}>
    {(active())! === "system" && <pre>{sections().systemPrompt || "No system prompt"}</pre>}
    {(active())! === "instructions" && (sections().instructions.length ? <Key each={sections().instructions} by={(instruction) => instruction.path}>{(instruction, index) => <div ><strong>{instruction().path}</strong><pre>{typeof instruction().content === "string" ? instruction().content : ""}</pre></div>}</Key> : <p>No project instructions</p>)}
    {(active())! === "tools" && (sections().tools.length ? <Key each={sections().tools} by={(tool) => tool.name}>{(tool, index) => <div ><strong>{tool().name}</strong>{typeof tool().description === "string" && tool().description && <p>{tool().description}</p>}<pre>{JSON.stringify(tool().parameters, null, 2)}</pre></div>}</Key> : <p>No active tools</p>)}
    {(active())! === "skills" && (sections().skills.length ? <Key each={sections().skills} by={(skill) => skill.filePath}>{(skill, index) => <div ><strong>{typeof skill().name === "string" ? skill().name : skill().filePath}</strong>{typeof skill().description === "string" && skill().description && <p>{skill().description}</p>}<small>{skill().filePath}</small></div>}</Key> : <p>No model-invoked skills</p>)}
  </div>);
  return <section class={`prompt-context${active() ? " open" : ""}`}>
    <div class="prompt-context-bar">
      <button class="system" aria-expanded={active() === "system"} onClick={() => toggle("system")}>System prompt <small>{percent().system}%</small></button>
      <button class="instructions" aria-expanded={active() === "instructions"} onClick={() => toggle("instructions")}>Instructions <small>{percent().instructions}%</small></button>
      <button class="tools" aria-expanded={active() === "tools"} onClick={() => toggle("tools")}>Tools <small>{percent().tools}%</small></button>
      <button class="skills" aria-expanded={active() === "skills"} onClick={() => toggle("skills")}>Skills <small>{percent().skills}%</small></button>
      <span class="prompt-context-wheel" style={wheelStyle()} title={`System ${percent().system}% · Instructions ${percent().instructions}% · Tools ${percent().tools}% · Skills ${percent().skills}%`} aria-label={`Prompt context: system ${percent().system}%, instructions ${percent().instructions}%, tools ${percent().tools}%, skills ${percent().skills}%`} />
    </div>
    {renderPromptContextContent()}
  </section>;
};
