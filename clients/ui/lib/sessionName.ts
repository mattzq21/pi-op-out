import { sentSkillPrompt } from "./composerPrompt";

export const capSessionName = (name: string) => Array.from(name.replace(/\s+/g, " ").trim()).slice(0, 50).join("").trimEnd();

/** The name a chat gets from its first prompt: the prompt without its Markdown links. */
export const promptName = (prompt: string) => capSessionName(prompt.replace(/\[(?:\\.|[^\]\\])*\]\([^)\s]*\)/g, " "));

/** A user prompt as the chat list shows it: a skill call shows as the prompt that the user wrote. */
export const promptTitle = (prompt: string) => sentSkillPrompt(prompt)?.text ?? prompt.trim();
