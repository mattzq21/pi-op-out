const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createInterface } = require("node:readline");
const path = require("node:path");
const os = require("node:os");

async function metadata(file) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let id;
  let parent;
  try {
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "session") id = entry.id;
      if (entry.type === "custom" && ["piop-subagent-parent", "piop-review-parent"].includes(entry.customType)) parent = entry.data?.parentSessionId;
      if (parent || entry.type === "message") break;
    }
  } finally { lines.close(); input.destroy(); }
  return { file, id, parent };
}

async function collect(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await collect(file));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(await metadata(file));
  }
  return result;
}

async function main() {
  const args = JSON.parse(process.argv[1]);
  const root = await fs.realpath(args.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "sessions"));
  const source = await fs.realpath(args.path);
  const relative = path.relative(root, source);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !source.endsWith(".jsonl")) throw new Error("Invalid conversation path");
  const parent = await metadata(source);
  if (typeof parent.id !== "string") throw new Error("Conversation has no session ID");
  const sessions = await collect(root);
  const ids = new Set([parent.id]);
  const files = new Set([source]);
  let added = true;
  while (added) {
    added = false;
    for (const session of sessions) {
      if (!files.has(session.file) && typeof session.id === "string" && ids.has(session.parent)) {
        files.add(session.file); ids.add(session.id); added = true;
      }
    }
  }
  process.stdout.write(JSON.stringify([...files].filter(file => file !== source)));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
