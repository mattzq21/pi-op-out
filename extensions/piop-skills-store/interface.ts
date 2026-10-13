/** Enabled skill paths from Piop settings. The daemon discovers the skills and reads their invocation policy. */
export type SkillLists = Readonly<{
  /** Skills only the user may invoke, for example with /skill:name. */
  userInvokedSkills: readonly string[];
  /** Skills the agent may also choose by itself. */
  agentInvokedSkills: readonly string[];
}>;

/** A skill as Pi lists it in the system prompt. */
export type PromptSkill = { filePath: string; baseDir: string; disableModelInvocation?: boolean };

/** One store per Pi process. The lists are disjoint; together they are the enabled skills. */
export interface SkillsStore {
  lists(): SkillLists;
  /** Every enabled skill path. */
  enabledSkills(): string[];
  /** Keeps the paths that name an enabled skill, in their given form and order. */
  selectEnabled(paths: readonly string[]): string[];
  /** Marks user-invoked skills so that the model is not told to use them. Returns new objects. */
  applyInvocationPolicy<T extends PromptSkill>(skills: readonly T[]): T[];
  /** Replaces both lists. Throws and keeps the old lists when value is invalid. Returns true when the lists changed. */
  replace(value: unknown): boolean;
}

/** Other extensions emit this request on "piop:skills-store" to get the store. */
export interface SkillsStoreRequest { store?: SkillsStore }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:skills-store", handler: (request: SkillsStoreRequest) => void): () => void;
    emit(channel: "piop:skills-store", request: SkillsStoreRequest): void;
  }
}
