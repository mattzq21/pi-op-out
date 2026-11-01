import { sentSkillPrompt } from "./composerPrompt";

export const capSessionName = (name: string) => Array.from(name.replace(/\s+/g, " ").trim()).slice(0, 50).join("").trimEnd();

/** A user prompt as the chat list shows it: a skill call shows as the prompt that the user wrote. */
export const promptTitle = (prompt: string) => sentSkillPrompt(prompt)?.text ?? prompt.trim();
