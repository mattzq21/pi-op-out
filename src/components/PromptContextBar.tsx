import { memo, useState } from "react";
import type { CSSProperties } from "react";
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

export const PromptContextBar = memo(function PromptContextBar({ context }: { context: PromptContextInfo }) {
  const [active, setActive] = useState<Section>();
  const { systemPrompt, instructions, tools, skills } = contextSections(context);
  const percent = shares(contextTokens(context));
  const wheelStyle = { "--prompt-system": `${percent.system}%`, "--prompt-instructions": `${percent.system + percent.instructions}%`, "--prompt-tools": `${percent.system + percent.instructions + percent.tools}%` } as CSSProperties;
  const toggle = (section: Section) => setActive((current) => current === section ? undefined : section);
  const renderPromptContextContent = () => (active && <div className={`prompt-context-content ${active}`}>
    {active === "system" && <pre>{systemPrompt || "No system prompt"}</pre>}
    {active === "instructions" && (instructions.length ? instructions.map((instruction) => <div key={instruction.path}><strong>{instruction.path}</strong><pre>{typeof instruction.content === "string" ? instruction.content : ""}</pre></div>) : <p>No project instructions</p>)}
    {active === "tools" && (tools.length ? tools.map((tool) => <div key={tool.name}><strong>{tool.name}</strong>{typeof tool.description === "string" && tool.description && <p>{tool.description}</p>}<pre>{JSON.stringify(tool.parameters, null, 2)}</pre></div>) : <p>No active tools</p>)}
    {active === "skills" && (skills.length ? skills.map((skill) => <div key={skill.filePath}><strong>{typeof skill.name === "string" ? skill.name : skill.filePath}</strong>{typeof skill.description === "string" && skill.description && <p>{skill.description}</p>}<small>{skill.filePath}</small></div>) : <p>No model-invoked skills</p>)}
  </div>);
  return <section className={`prompt-context${active ? " open" : ""}`}>
    <div className="prompt-context-bar">
      <button className="system" aria-expanded={active === "system"} onClick={() => toggle("system")}>System prompt <small>{percent.system}%</small></button>
      <button className="instructions" aria-expanded={active === "instructions"} onClick={() => toggle("instructions")}>Instructions <small>{percent.instructions}%</small></button>
      <button className="tools" aria-expanded={active === "tools"} onClick={() => toggle("tools")}>Tools <small>{percent.tools}%</small></button>
      <button className="skills" aria-expanded={active === "skills"} onClick={() => toggle("skills")}>Skills <small>{percent.skills}%</small></button>
      <span className="prompt-context-wheel" style={wheelStyle} title={`System ${percent.system}% · Instructions ${percent.instructions}% · Tools ${percent.tools}% · Skills ${percent.skills}%`} aria-label={`Prompt context: system ${percent.system}%, instructions ${percent.instructions}%, tools ${percent.tools}%, skills ${percent.skills}%`} />
    </div>
    {renderPromptContextContent()}
  </section>;
});
