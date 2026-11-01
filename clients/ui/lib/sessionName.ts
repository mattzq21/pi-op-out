import { sentSkillPrompt } from "./composerPrompt";

export const capSessionName = (name: string) => Array.from(name.replace(/\s+/g, " ").trim()).slice(0, 50).join("").trimEnd();

export const promptName = (prompt: string) => capSessionName(prompt.replace(/\[((?:\\.|[^\]\\])*)\]\([^)\s]*\)/g, (_link, label) => label.replace(/\\(.)/g, "$1")));

export const promptTitle = (prompt: string) => sentSkillPrompt(prompt)?.text ?? prompt.trim();
