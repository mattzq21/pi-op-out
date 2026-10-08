const fs = require("node:fs/promises");
const { Type } = require("typebox");
const { Check } = require("typebox/value");

const sessionIdSchema = Type.String();

const parentSchema = Type.Object({ parentSessionId: Type.String(), sessionId: Type.Optional(Type.String()) });

const entrySchema = Type.Object({ type: Type.String() });

const headerSchema = Type.Object({ type: Type.Literal("session"), id: Type.String(), parentSession: Type.Optional(Type.Unknown()) });

const { createReadStream } = require("node:fs");
const { createInterface } = require("node:readline");
const path = require("node:path");
const os = require("node:os");

async function metadata(file) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let id;
  let parent;
  let ownParent;
  let fork = false;
  let malformed = 0;

  try {
    for await (const line of lines) {
      const entry = savedEntry(line);

      if (!entry) { malformed += Number(Boolean(line.trim())); continue; }

      if (id === undefined && Check(headerSchema, entry)) { id = entry.id; fork = Boolean(entry.parentSession); }

      if (!parentEntry(entry)) continue;

      if (entry.data.sessionId === id) ownParent = entry.data.parentSessionId;
      else if (entry.data.sessionId === undefined) parent = entry.data.parentSessionId;
    }
  } finally { lines.close(); input.destroy(); }

  warnMalformed(file, malformed);

  return { file, id, parent: ownParent ?? (fork ? undefined : parent) };
}

function warnMalformed(file, count) {
  if (count) console.error(`Skipped ${count} malformed records in ${file}; descendant lineage may be incomplete`);
}

function savedEntry(line) {
  let entry;

  try { entry = JSON.parse(line); } catch { return; }

  return Check(entrySchema, entry) ? entry : undefined;
}

function parentEntry(entry) {
  return entry.type === "custom" && ["piop-subagent-parent", "piop-review-parent"].includes(entry.customType) && Check(parentSchema, entry.data);
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

async function validatedParent(root, source) {
  const relative = path.relative(root, source);

  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !source.endsWith(".jsonl")) throw new Error("Invalid conversation path");
  const parent = await metadata(source);

  if (!Check(sessionIdSchema, parent.id)) throw new Error("Conversation has no session ID");

  return parent;
}

async function collectOtherArea(args, root, sessions, archivedFiles) {
    const otherRoot = path.join(root, "..", args.archived ? "sessions" : "archived");
    let exists = true;

    try { await fs.access(otherRoot); }
    catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }

    const other = exists ? await collect(otherRoot) : [];
    sessions.push(...other);

    if (!args.archived) other.forEach(session => archivedFiles.add(session.file));


}

async function main() {
  const args = JSON.parse(process.argv[1]);
  const area = args.archived ? "archived" : "sessions";
  const root = await fs.realpath(args.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", area));
  const source = await fs.realpath(args.path);
  const parent = await validatedParent(root, source);
  const sessions = await collect(root);
  const archivedFiles = new Set(args.archived ? sessions.map(session => session.file) : []);

  if (args.includeOtherArea) await collectOtherArea(args, root, sessions, archivedFiles);

  const children = descendants(sessions, parent.id, source);
  process.stdout.write(JSON.stringify(args.includeOtherArea ? children.map(file => [file, archivedFiles.has(file)]) : children));
}

function descendants(sessions, parentId, source) {
  const ids = new Set([parentId]);
  const files = new Set([source]);
  let added = true;

  while (added) {
    added = false;

    for (const session of sessions) {
      if (!files.has(session.file) && Check(sessionIdSchema, session.id) && ids.has(session.parent)) {
        files.add(session.file); ids.add(session.id); added = true;
      }
    }
  }

  return [...files].filter(file => file !== source);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
