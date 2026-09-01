import { useState } from "react";
import type { CSSProperties } from "react";
import type { PromptContextInfo } from "../types";

type Section = "system" | "tools" | "skills";

function shares(tokens: PromptContextInfo["tokens"]) {
  const total = tokens.system + tokens.tools + tokens.skills;
  if (!total) return { system: 0, tools: 0, skills: 0 };
  const system = Math.round(tokens.system / total * 100);
  const tools = Math.round(tokens.tools / total * 100);
  return { system, tools, skills: 100 - system - tools };
}

export function PromptContextBar({ context }: { context: PromptContextInfo }) {
  const [active, setActive] = useState<Section>();
  const percent = shares(context.tokens);
  const wheelStyle = { "--prompt-system": `${percent.system}%`, "--prompt-tools": `${percent.system + percent.tools}%` } as CSSProperties;
  const toggle = (section: Section) => setActive((current) => current === section ? undefined : section);
  return <section className={`prompt-context${active ? " open" : ""}`}>
    <div className="prompt-context-bar">
      <button className="system" aria-expanded={active === "system"} onClick={() => toggle("system")}>System prompt <small>{percent.system}%</small></button>
      <button className="tools" aria-expanded={active === "tools"} onClick={() => toggle("tools")}>Tools <small>{percent.tools}%</small></button>
      <button className="skills" aria-expanded={active === "skills"} onClick={() => toggle("skills")}>Skills <small>{percent.skills}%</small></button>
      <span className="prompt-context-wheel" style={wheelStyle} title={`System ${percent.system}% · Tools ${percent.tools}% · Skills ${percent.skills}%`} aria-label={`Prompt context: system ${percent.system}%, tools ${percent.tools}%, skills ${percent.skills}%`} />
    </div>
    {active && <div className={`prompt-context-content ${active}`}>
      {active === "system" && <pre>{context.systemPrompt || "No system prompt"}</pre>}
      {active === "tools" && (context.tools.length ? context.tools.map((tool) => <div key={tool.name}><strong>{tool.name}</strong>{tool.description && <p>{tool.description}</p>}<pre>{JSON.stringify(tool.parameters, null, 2)}</pre></div>) : <p>No active tools</p>)}
      {active === "skills" && (context.skills.length ? context.skills.map((skill) => <div key={skill.filePath}><strong>{skill.name}</strong>{skill.description && <p>{skill.description}</p>}<small>{skill.filePath}</small></div>) : <p>No model-invoked skills</p>)}
    </div>}
  </section>;
}
