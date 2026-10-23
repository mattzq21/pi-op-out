import { required } from "../lib/required";
import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Check, CircleAlert, Copy } from "lucide-solid";
import { IconButton } from "./IconButton";
import { ContextTokenDiagram } from "./ContextTokenDiagram";
import { type CSSProperties } from "../lib/solid";

import type { PromptContextInfo } from "../types";
import { separatePromptInstructions } from "../lib/promptInstructions";
import { promptContextSchema } from "../lib/messageSchemas";
import { copyText } from "../lib/clipboard";

type Section = "system" | "instructions" | "tools" | "skills";

function ContextCopyButton(props: { content: () => string; label?: string; class?: string }) {
  const [state, setState] = createSignal<"idle" | "copied" | "error">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; clearTimeout(timer); });

  const copy = async () => {
    clearTimeout(timer);

    try { await copyText(props.content());

    if (!disposed) setState("copied"); }
    catch { if (!disposed) setState("error"); }

    if (!disposed) timer = setTimeout(() => setState("idle"), 1800);
  };

  return <IconButton class={props.class ?? "prompt-context-copy"} label={state() === "copied" ? "Copied" : state() === "error" ? "Copy failed" : props.label ?? "Copy tab content"} onClick={copy}>{state() === "copied" ? <Check size={14} /> : state() === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>;
}

/** The copy button of one item: a tool with its JSON, an instruction file or a skill. */
function ItemCopy(props: { name?: string; content: () => string }) {
  return <ContextCopyButton class="prompt-context-copy prompt-context-item-copy" label={`Copy ${props.name ?? "item"}`} content={props.content} />;
}

function shares(values: { system: number; instructions: number; tools: number; skills: number }) {
  const keys: Section[] = ["system", "instructions", "tools", "skills"];
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
  return context.tokens;
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
  const systemPrompt = context.systemPrompt
    .replace(/<skills>[\s\S]*?<\/skills>/g, "")
    .replace(/(?:^|\n\n)The following skills provide specialized instructions[\s\S]*?<\/available_skills>/g, "")
    .replace(/\n{3,}/g, "\n\n").trim();

  const { instructions, tools, skills } = context;
  const userInvokedSkills = context.userInvokedSkills ?? [];

  return { systemPrompt, instructions, tools, skills, userInvokedSkills };
}

export const PromptContextBar = function PromptContextBar(componentProps: { context: PromptContextInfo; inputTokens: number }) {
  const context = createMemo(() => separatePromptInstructions(promptContextSchema.parse(componentProps.context)));
  const [active, setActive] = createSignal<Section>();
  const [skillTab, setSkillTab] = createSignal<"tax" | "model" | "user">("model");
  const taxText = () => skillTax(context()).replace(/^<skills>\s*/, "") || "No skills tax in this context";
  const sections = createMemo(() => (contextSections(context())));
  const visibleSkills = (): NonNullable<PromptContextInfo["userInvokedSkills"]> => skillTab() === "model" ? sections().skills : sections().userInvokedSkills;
  const emptySkills = () => skillTab() === "model" ? "No defined skills" : "No skills invoked in this context";
  const skillPercent = createMemo(() => skillPercentages(context()));
  const tokens = createMemo(() => contextTokens(context()));
  const percent = createMemo(() => shares(tokens()));
  const wheelStyle = createMemo(() => ({ "--prompt-system": `${percent().system}%`, "--prompt-instructions": `${percent().system + percent().instructions}%`, "--prompt-tools": `${percent().system + percent().instructions + percent().tools}%` } satisfies CSSProperties));
  const toggle = (section: Section) => setActive((current) => current === section ? undefined : section);

  const renderSkillContents = () => (skillTab() === "tax" ? <pre>{taxText()}</pre> : visibleSkills().length ? <Key each={visibleSkills()} by={(skill) => skill.id ?? skill.filePath}>{(skill, _index) => skillTab() === "user"
        ? <div class="prompt-context-item"><ItemCopy name={skill().name} content={() => [skill().name, skill().filePath, skill().content].filter(Boolean).join("\n")} /><details class="prompt-skill-invocation"><summary>{skill().name}</summary><small>{skill().filePath}</small><pre>{skill().content ?? "Skill body was not recorded in this snapshot."}</pre></details></div>
        : <div class="prompt-context-item"><ItemCopy name={skill().name} content={() => [skill().name, skill().description, skill().filePath].filter(Boolean).join("\n")} /><strong>{skill().name}</strong>{skill().description && <p>{skill().description}</p>}<small>{skill().filePath}</small></div>}</Key> : <p>{emptySkills()}</p>);

  const renderPromptContextContent = () => (active() && <div class={`prompt-context-content ${required((active()))}`}>
    <Show when={active() === "system" || (active() === "skills" && skillTab() === "tax")}><ContextCopyButton content={() => active() === "system" ? sections().systemPrompt || "No system prompt" : taxText()} /></Show>
    {required((active())) === "system" && <pre>{sections().systemPrompt || "No system prompt"}</pre>}
    {required((active())) === "instructions" && (sections().instructions.length ? <Key each={sections().instructions} by={(instruction) => instruction.path}>{(instruction, _index) => <div class="prompt-context-item"><ItemCopy name={instruction().path} content={() => `${instruction().path}
${instruction().content ?? ""}`} /><strong>{instruction().path}</strong><pre>{instruction().content}</pre></div>}</Key> : <p>No project instructions</p>)}
    {required((active())) === "tools" && (sections().tools.length ? <Key each={sections().tools} by={(tool) => tool.name}>{(tool, _index) => <div class="prompt-context-item"><ItemCopy name={tool().name} content={() => [tool().name, tool().description, JSON.stringify(tool().parameters, null, 2)].filter(Boolean).join("\n")} /><strong>{tool().name}</strong>{tool().codemode && <span class="prompt-context-codemode">CM</span>}{tool().description && <p>{tool().description}</p>}<details class="prompt-context-tool-json"><summary>JSON</summary><pre>{JSON.stringify(tool().parameters, null, 2)}</pre></details></div>}</Key> : <p>No active tools</p>)}
    {required((active())) === "skills" && <>
      <nav class="prompt-skills-tabs" aria-label="Skill categories">
        <button type="button" aria-pressed={skillTab() === "model"} data-tooltip="Share of total estimated context used by skill definitions" onClick={() => setSkillTab("model")}>Defined <small>{skillPercent().defined}%</small></button>
        <button type="button" aria-pressed={skillTab() === "user"} data-tooltip="Share of total estimated context used by invoked skills" onClick={() => setSkillTab("user")}>Invoked <small>{skillPercent().invoked}%</small></button>
        <button type="button" aria-pressed={skillTab() === "tax"} data-tooltip="Share of total estimated context used by shared skill instructions" onClick={() => setSkillTab("tax")}>Tax <small>{skillPercent().tax}%</small></button>
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
      <ContextTokenDiagram tokens={componentProps.inputTokens} style={wheelStyle()} />
    </div>
    {renderPromptContextContent()}
  </section>;
};
