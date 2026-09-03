import { useState } from "react";
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

export function PromptContextBar({ context }: { context: PromptContextInfo }) {
  const [active, setActive] = useState<Section>();
  const percent = shares(context.tokens);
  const wheelStyle = { "--prompt-system": `${percent.system}%`, "--prompt-instructions": `${percent.system + percent.instructions}%`, "--prompt-tools": `${percent.system + percent.instructions + percent.tools}%` } as CSSProperties;
  const toggle = (section: Section) => setActive((current) => current === section ? undefined : section);
  return <section className={`prompt-context${active ? " open" : ""}`}>
    <div className="prompt-context-bar">
      <button className="system" aria-expanded={active === "system"} onClick={() => toggle("system")}>System prompt <small>{percent.system}%</small></button>
      <button className="instructions" aria-expanded={active === "instructions"} onClick={() => toggle("instructions")}>Instructions <small>{percent.instructions}%</small></button>
      <button className="tools" aria-expanded={active === "tools"} onClick={() => toggle("tools")}>Tools <small>{percent.tools}%</small></button>
      <button className="skills" aria-expanded={active === "skills"} onClick={() => toggle("skills")}>Skills <small>{percent.skills}%</small></button>
      <span className="prompt-context-wheel" style={wheelStyle} title={`System ${percent.system}% · Instructions ${percent.instructions}% · Tools ${percent.tools}% · Skills ${percent.skills}%`} aria-label={`Prompt context: system ${percent.system}%, instructions ${percent.instructions}%, tools ${percent.tools}%, skills ${percent.skills}%`} />
    </div>
    {active && <div className={`prompt-context-content ${active}`}>
      {active === "system" && <pre>{context.systemPrompt || "No system prompt"}</pre>}
      {active === "instructions" && (context.instructions.length ? context.instructions.map((instruction) => <div key={instruction.path}><strong>{instruction.path}</strong><pre>{instruction.content}</pre></div>) : <p>No project instructions</p>)}
      {active === "tools" && (context.tools.length ? context.tools.map((tool) => <div key={tool.name}><strong>{tool.name}</strong>{tool.description && <p>{tool.description}</p>}<pre>{JSON.stringify(tool.parameters, null, 2)}</pre></div>) : <p>No active tools</p>)}
      {active === "skills" && (context.skills.length ? context.skills.map((skill) => <div key={skill.filePath}><strong>{skill.name}</strong>{skill.description && <p>{skill.description}</p>}<small>{skill.filePath}</small></div>) : <p>No model-invoked skills</p>)}
    </div>}
  </section>;
}
