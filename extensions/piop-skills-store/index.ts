import { Type } from "typebox";
import { Check } from "typebox/value";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { readFile as readRecord } from "../app-settings.cjs";
import type { PromptSkill, SkillLists, SkillsStore } from "./interface.ts";

/** The lists are shared by every Pi session in this process. */
const key = Symbol.for("piop.skills-store");

const listsSchema = Type.Object({ userInvokedSkills: Type.Array(Type.String()), agentInvokedSkills: Type.Array(Type.String()) }, { additionalProperties: false });

const readingTools: Array<"read" | "bash"> = ["read", "bash"];

const skillPath = (path: string) => resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

function parse(value: unknown): SkillLists {
  if (!Check(listsSchema, value)) throw new Error("Invalid skill lists");
  const user = new Set(value.userInvokedSkills.map(skillPath));
  const both = value.agentInvokedSkills.find(path => user.has(skillPath(path)));

  if (both !== undefined) throw new Error(`Skill ${both} cannot be both user invoked and agent invoked`);

  return structuredClone(value);
}

function stored(): SkillLists | undefined { return Object.getOwnPropertyDescriptor(globalThis, key)?.value; }

function save(lists: SkillLists) { Object.defineProperty(globalThis, key, { value: lists, writable: true, configurable: true, enumerable: true }); }

function current(): SkillLists {
  const lists = stored();

  if (!lists) throw new Error("Skill lists are unavailable");

  return lists;
}

const store: SkillsStore = {
  lists: () => structuredClone(current()),
  enabledSkills: () => [...current().agentInvokedSkills, ...current().userInvokedSkills],
  selectEnabled(paths) {
    const enabled = new Set(store.enabledSkills().map(skillPath));

    return paths.filter(path => enabled.has(skillPath(path)));
  },
  applyInvocationPolicy(skills) {
    const user = new Set(current().userInvokedSkills.map(skillPath));

    return skills.map(skill => user.has(skillPath(skill.filePath)) || user.has(skillPath(skill.baseDir)) ? { ...skill, disableModelInvocation: true } : { ...skill });
  },
  replace(value) {
    const next = parse(value);
    const changed = JSON.stringify(next) !== JSON.stringify(current());
    save(next);

    return changed;
  },
};

export default function skillsStore(pi: ExtensionAPI) {
  if (!stored()) save(parse(readRecord(process.env.PIOP_SKILLS_STORE_PATH || join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "skills-store.json"))));
  const unsubscribe = pi.events.on("piop:skills-store", request => { request.store = store; });
  const agentsDefined = () => process.env.PI_DEFINE_AGENTS_ACTIVE === "1";

  // Agent definitions select their own skills. Without them, the session gets every enabled skill.
  pi.on("resources_discover", () => agentsDefined() ? undefined : { skillPaths: store.enabledSkills() });
  pi.on("before_agent_start", (event) => {
    if (agentsDefined() || !current().userInvokedSkills.length) return;
    const options = event.systemPromptOptions;
    const readTool = readingTools.find((tool) => (options.selectedTools ?? ["read", "bash"]).includes(tool));

    if (!readTool || !options.skills?.length) return;
    const original = formatSkillsForPrompt(options.skills, readTool);
    const filtered = formatSkillsForPrompt(store.applyInvocationPolicy(options.skills as Array<(typeof options.skills)[number] & PromptSkill>), readTool);

    if (original && original !== filtered) return { systemPrompt: event.systemPrompt.replace(original, filtered) };
  });
  pi.on("session_shutdown", () => { unsubscribe(); });
}
