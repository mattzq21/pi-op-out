import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { fileErrorSchema } from "./schemas.ts";

type ForkPublication = { source: string; destination: string; sessionId: string; content: string };

export class ForkPublicationPending extends Error {}

async function publicationScript() {
  try { return await readFile(new URL("./publish-fork.bundle.mjs", import.meta.url), "utf8"); }
  catch (error) {
    if (!Check(fileErrorSchema, error) || error.code !== "ENOENT") throw error;

    return readFile(new URL("../../src-tauri/resources/publish-fork.bundle.mjs", import.meta.url), "utf8");
  }
}

function invoke(script: string, request: string, content?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", script, request], { encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(content);
  });
}

export async function publishFork(publication: ForkPublication) {
  const script = await publicationScript();
  const { content, ...details } = publication;
  const request = { ...details, root: join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop"), inline: true };

  try { await invoke(script, JSON.stringify(request), content); }
  catch (error) {
    let restored;

    try {
      restored = JSON.parse(await invoke(script, JSON.stringify({ ...request, action: "result" })));

      if (!Check(Type.Boolean(), restored)) throw new Error("Invalid fork publication response");
    } catch (cause) { throw new ForkPublicationPending(`Fork recovery is pending at ${publication.destination}: ${String(cause)}`); }

    if (!restored) throw error;
  }
}
