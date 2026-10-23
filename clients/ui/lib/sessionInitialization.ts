import { isConversationChanged } from "./conversationChanged";

async function initializationStep<T>(label: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out ${label}. Retry the connection.`)), 30000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function initializeSession<T>(current: () => boolean, steps: { connect: () => Promise<void>; loadSettings: () => Promise<T>; refresh: (settings: T) => Promise<T>; configure: (settings: T) => Promise<void> }) {
  for (let attempt = 0; attempt < 3 && current(); attempt++) {
    try {
      const [loadedSettings] = await Promise.all([
        initializationStep("loading settings", steps.loadSettings),
        initializationStep("starting the conversation", steps.connect),
      ]);

      if (!current()) return false;
      await initializationStep("configuring the agent", () => steps.configure(loadedSettings));

      if (!current()) return false;
      await initializationStep("loading the conversation", () => steps.refresh(loadedSettings));

      return current();
    } catch (reason) {
      if (!current()) return false;

      if (!isConversationChanged(reason)) throw reason;

      if (attempt === 2) throw new Error("Conversation initialization was repeatedly interrupted. Retry the connection.");
    }
  }

  return false;
}
