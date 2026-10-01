import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { request } from "./client.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

const CATCH_UP_MESSAGE = "pi-desktop-catch-up";

export function registerCatchUp(pi: ExtensionAPI) {
  let running = false;
  const presenceId = crypto.randomUUID();
  const publishWorktree = (ctx: ExtensionContext, worktree: string | null) => ctx.ui.setStatus("pi-desktop-worktree-presence", JSON.stringify({ id: presenceId, worktree }));
  pi.on("session_start", async (_event, ctx) => {
    try {
      const { stdout } = await runFile("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"]);
      publishWorktree(ctx, await realpath(stdout.trimEnd()));
    } catch { publishWorktree(ctx, null); }
  });

  const assertWorktreeIdle = async () => {
    const agents = await request("/worktree-agents", { id: presenceId }) as Array<{ sessionId?: string }>;

    if (agents.length) throw new Error(`Another Pi UI agent is working in this worktree${agents[0].sessionId ? ` (session ${agents[0].sessionId})` : ""}. Stop or pause it before catching up.`);
  };

  function assertMainWorktree(first: string[], main: string | undefined): asserts main is string {
    if (!main || first.includes("bare")) throw new Error("No main working tree is available for this repository.");
  }

  const catchUpError = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  pi.registerCommand("catch-up", {
    description: "Reset this secondary worktree to the main worktree's commit (discards tracked changes)",
    async handler(args, ctx) {
      const report = (content: string) => pi.sendMessage({ customType: CATCH_UP_MESSAGE, content, display: true }, { triggerTurn: false });

      if (args.trim()) { report("Usage: /catch-up");

      return; }

      if (running) { report("Catch-up is already running.");

      return; }

      if (!ctx.isIdle()) { report("Stop or pause the agent before running /catch-up.");

      return; }

      running = true;

      try {
        const git = async (cwd: string, ...args: string[]) => {
          const { stdout } = await runFile("git", ["-C", cwd, ...args], { maxBuffer: 1024 * 1024 });

          return stdout;
        };

        const root = (await git(ctx.cwd, "rev-parse", "--show-toplevel")).trimEnd();
        const first = (await git(root, "worktree", "list", "--porcelain", "-z")).split("\0\0")[0].split("\0");
        const main = first.find((field) => field.startsWith("worktree "))?.slice(9);
        assertMainWorktree(first, main);

        if (await realpath(root) === await realpath(main)) { report("Already in the main worktree. Nothing changed.");

        return; }

        await assertWorktreeIdle();
        const commit = (await git(main, "rev-parse", "--verify", "HEAD^{commit}")).trim();
        const confirmed = await ctx.ui.confirm("Catch up this worktree?", `Reset ${root} to the main worktree (${main}) at commit ${commit.slice(0, 12)}? This discards tracked local changes and moves the current branch to that commit. Uncommitted changes in the main worktree will not be copied.`);

        if (!confirmed) return;

        if (!ctx.isIdle()) throw new Error("Stop or pause the agent before running /catch-up.");
        await assertWorktreeIdle();
        const untracked = (await git(root, "ls-files", "--others", "-z", "--")).split("\0").filter(Boolean);
        const targetPaths = (await git(root, "ls-tree", "-r", "--name-only", "-z", commit)).split("\0").filter(Boolean);
        const collision = untracked.find((file) => targetPaths.some((target) => file === target || file.startsWith(`${target}/`) || target.startsWith(`${file}/`)));

        if (collision) throw new Error(`Untracked path ${JSON.stringify(collision)} would be overwritten. Move or commit it before catching up.`);
        await git(root, "reset", "--hard", commit);
        report(`Caught up to the main worktree at ${commit.slice(0, 12)}.`);
      } catch (error) {
        report(`Catch-up failed: ${catchUpError(error)}`);
      } finally { running = false; }
    },
  });
  pi.on("context", (event) => ({ messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== CATCH_UP_MESSAGE) }));
}
