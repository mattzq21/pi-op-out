import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal, onCleanup } from "solid-js";
import { Check, CircleAlert, Copy } from "lucide-solid";
import { IconButton } from "./IconButton";
import { type CSSProperties } from "../lib/solid";

import type { PromptContextInfo } from "../types";
import { separatePromptInstructions } from "../lib/promptInstructions";

type Section = "system" | "instructions" | "tools" | "skills";

function ContextCopyButton(props: { content: () => string }) {
  const [state, setState] = createSignal<"idle" | "copied" | "error">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; clearTimeout(timer); });
  const copy = async () => {
    clearTimeout(timer);
    try { await navigator.clipboard.writeText(props.content()); if (!disposed) setState("copied"); }
    catch { if (!disposed) setState("error"); }
    if (!disposed) timer = setTimeout(() => setState("idle"), 1800);
  };
  return <IconButton class="prompt-context-copy" label={state() === "copied" ? "Copied" : state() === "error" ? "Copy failed" : "Copy tab content"} onClick={copy}>{state() === "copied" ? <Check size={14} /> : state() === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>;
}

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

function validSkills<T extends { filePath: string }>(skills: T[] | undefined): T[] {
  return Array.isArray(skills) ? skills.filter(item => Boolean(item) && typeof item.filePath === "string") : [];
}

function skillTax(context: PromptContextInfo) {
  return context.systemPrompt.match(/(?:<skills>\s*)?The following skills provide specialized instructions[\s\S]*?(?=<available_skills>)/)?.[0].trim() ?? "";
}

function skillPercentages(context: PromptContextInfo) {
  const invoked = context.skillTokens?.invoked ?? (context.userInvokedSkills ?? []).reduce((sum, skill) => sum + Math.ceil((skill.content ?? "").length / 4), 0);
  const defined = context.skillTokens?.defined ?? Math.max(0, contextTokens(context).skills - invoked);
  const tax = Math.min(defined, Math.ceil(skillTax(context).length / 4));
  const total = Math.max(1, Object.values(contextTokens(context)).reduce((sum, value) => sum + value, 0));
  return { tax: Math.round(tax / total * 100), defined: Math.round((defined - tax) / total * 100), invoked: Math.round(invoked / total * 100) };
}

function contextSections(context: PromptContextInfo) {
  const systemPrompt = typeof context?.systemPrompt === "string" ? context.systemPrompt
    .replace(/<skills>[\s\S]*?<\/skills>/g, "")
    .replace(/(?:^|\n\n)The following skills provide specialized instructions[\s\S]*?<\/available_skills>/g, "")
    .replace(/\n{3,}/g, "\n\n").trim() : "";
  const instructions = Array.isArray(context?.instructions) ? context.instructions.filter((item): item is NonNullable<typeof item> => Boolean(item) && typeof (item as { path?: unknown }).path === "string") : [];
  const tools = Array.isArray(context?.tools) ? context.tools.filter((item): item is NonNullable<typeof item> => Boolean(item) && typeof (item as { name?: unknown }).name === "string") : [];
  const skills = validSkills(context?.skills);
  const userInvokedSkills = validSkills(context?.userInvokedSkills);
  return { systemPrompt, instructions, tools, skills, userInvokedSkills };
}

export const PromptContextBar = function PromptContextBar(componentProps: { context: PromptContextInfo }) {
  const context = createMemo(() => separatePromptInstructions(componentProps.context));
  const [active, setActive] = createSignal<Section>();
  const [skillTab, setSkillTab] = createSignal<"tax" | "model" | "user">("tax");
  const taxText = () => skillTax(context()).replace(/^<skills>\s*/, "") || "No skills tax in this context";
  const sections = createMemo(() => (contextSections(context())));
  const visibleSkills = (): NonNullable<PromptContextInfo["userInvokedSkills"]> => skillTab() === "model" ? sections().skills : sections().userInvokedSkills;
  const emptySkills = () => skillTab() === "model" ? "No defined skills" : "No skills invoked in this context";
  const copySkills = () => skillTab() === "tax" ? taxText() : visibleSkills().map((item) => [item.name ?? item.filePath, item.description, item.filePath, item.content].filter(Boolean).join("\n")).join("\n\n") || emptySkills();
  const skillPercent = createMemo(() => skillPercentages(context()));
  const tokens = createMemo(() => contextTokens(context()));
  const totalTokens = createMemo(() => Object.values(tokens()).reduce((sum, value) => sum + value, 0));
  const percent = createMemo(() => shares(tokens()));
  const wheelStyle = createMemo(() => ({ "--prompt-system": `${percent().system}%`, "--prompt-instructions": `${percent().system + percent().instructions}%`, "--prompt-tools": `${percent().system + percent().instructions + percent().tools}%` } as CSSProperties));
  const toggle = (section: Section) => setActive((current) => current === section ? undefined : section);
  const renderSkillContents = () => (skillTab() === "tax" ? <pre>{taxText()}</pre> : visibleSkills().length ? <Key each={visibleSkills()} by={(skill) => skill.id ?? skill.filePath}>{(skill, _index) => skillTab() === "user"
        ? <details class="prompt-skill-invocation"><summary>{skill().name}</summary><small>{skill().filePath}</small><pre>{skill().content ?? "Skill body was not recorded in this snapshot."}</pre></details>
        : <div><strong>{typeof skill().name === "string" ? skill().name : skill().filePath}</strong>{typeof skill().description === "string" && skill().description && <p>{skill().description}</p>}<small>{skill().filePath}</small></div>}</Key> : <p>{emptySkills()}</p>);
  const renderPromptContextContent = () => (active() && <div class={`prompt-context-content ${(active())!}`}>
    <ContextCopyButton content={() => {
      const section = sections();
      switch (active()) {
        case "system": return section.systemPrompt || "No system prompt";
        case "instructions": return section.instructions.map((item) => `${item.path}\n${item.content ?? ""}`).join("\n\n") || "No project instructions";
        case "tools": return section.tools.map((item) => [item.name, item.description, JSON.stringify(item.parameters, null, 2)].filter(Boolean).join("\n")).join("\n\n") || "No active tools";
        case "skills": return copySkills();
        default: return "";
      }
    }} />
    {(active())! === "system" && <pre>{sections().systemPrompt || "No system prompt"}</pre>}
    {(active())! === "instructions" && (sections().instructions.length ? <Key each={sections().instructions} by={(instruction) => instruction.path}>{(instruction, _index) => <div ><strong>{instruction().path}</strong><pre>{typeof instruction().content === "string" ? instruction().content : ""}</pre></div>}</Key> : <p>No project instructions</p>)}
    {(active())! === "tools" && (sections().tools.length ? <Key each={sections().tools} by={(tool) => tool.name}>{(tool, _index) => <div ><strong>{tool().name}</strong>{typeof tool().description === "string" && tool().description && <p>{tool().description}</p>}<details class="prompt-context-tool-json"><summary>JSON</summary><pre>{JSON.stringify(tool().parameters, null, 2)}</pre></details></div>}</Key> : <p>No active tools</p>)}
    {(active())! === "skills" && <>
      <nav class="prompt-skills-tabs" aria-label="Skill categories">
        <button type="button" aria-pressed={skillTab() === "tax"} title="Share of total estimated context used by shared skill instructions" onClick={() => setSkillTab("tax")}>Tax <small>{skillPercent().tax}%</small></button>
        <button type="button" aria-pressed={skillTab() === "model"} title="Share of total estimated context used by skill definitions" onClick={() => setSkillTab("model")}>Defined <small>{skillPercent().defined}%</small></button>
        <button type="button" aria-pressed={skillTab() === "user"} title="Share of total estimated context used by invoked skills" onClick={() => setSkillTab("user")}>Invoked <small>{skillPercent().invoked}%</small></button>
      </nav>
      {renderSkillContents()}
    </>}
  </div>);
  return <section class={`prompt-context${active() ? " open" : ""}`}>
    <div class="prompt-context-bar">
      <button class="system" aria-expanded={active() === "system"} onClick={() => toggle("system")}>System prompt <small>{percent().system}%</small></button>
      <button class="instructions" aria-expanded={active() === "instructions"} onClick={() => toggle("instructions")}>Instructions <small>{percent().instructions}%</small></button>
      <button class="tools" aria-expanded={active() === "tools"} onClick={() => toggle("tools")}>Tools <small>{percent().tools}%</small></button>
      <button class="skills" aria-expanded={active() === "skills"} onClick={() => toggle("skills")}>Skills <small>{percent().skills}%</small></button>
      <span class="prompt-context-wheel" style={wheelStyle()} title={`${totalTokens().toLocaleString()} tokens`} aria-label={`${totalTokens().toLocaleString()} tokens`} />
    </div>
    {renderPromptContextContent()}
  </section>;
};
