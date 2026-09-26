const DESKTOP_TITLE = "__pi_desktop_btw__";

type PiApi = {
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: CommandContext): Promise<void> }): void;
};

type CommandContext = {
  cwd: string;
  sessionManager: { getSessionFile(): string | undefined; getLeafId(): string | null };
  ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, type: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
};

export default function btwExtension(pi: PiApi) {
  pi.registerCommand("btw", {
    description: "Open an ephemeral side conversation branched from the current response",
    handler: async (rawArgs, ctx) => {
      const task = rawArgs.trim();
      if (!task) {
        ctx.ui.notify("/btw needs a message to send", "warning");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("/btw needs a persisted session to branch from", "error");
        return;
      }

      const parentLeafId = ctx.sessionManager.getLeafId();
      ctx.ui.setStatus("btw", "Running side conversation…");
      void (async () => {
        try {
          await ctx.ui.input(DESKTOP_TITLE, JSON.stringify({ task, sessionFile, leafId: parentLeafId, cwd: ctx.cwd }));
        } catch (error) {
          ctx.ui.notify(`/btw failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          ctx.ui.setStatus("btw", undefined);
        }
      })();
    },
  });
}
