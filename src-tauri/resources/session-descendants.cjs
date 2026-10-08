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
const io = require("./session-broker/session-publication-io.cjs");
const childIndex = require("./session-broker/session-child-index.cjs");

class MissingChildIndex extends Error {}

async function metadata(file) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const state = { id: undefined, parent: undefined, ownParent: undefined, kind: undefined, fork: false, malformed: 0 };

  try {
    for await (const line of lines) {
      readMetadataLine(line, state);
    }
  } finally { lines.close(); input.destroy(); }

  warnMalformed(file, state.malformed);

  if (state.malformed) throw new Error(`Cannot index incomplete conversation lineage: ${file}`);

  return { file, id: state.id, parent: state.ownParent ?? (state.fork ? undefined : state.parent), kind: state.kind };
}

function readMetadataLine(line, state) {
  const entry = savedEntry(line);

  if (!entry) { state.malformed += Number(Boolean(line.trim()));

  return; }

  if (state.id === undefined && Check(headerSchema, entry)) { state.id = entry.id; state.fork = Boolean(entry.parentSession); }

  if (!parentEntry(entry)) return;
  const kind = entry.customType === "piop-subagent-parent" ? "subagent" : "review";

  if (entry.data.sessionId === state.id) { state.ownParent = entry.data.parentSessionId; state.kind = kind; }
  else if (entry.data.sessionId === undefined) { state.parent = entry.data.parentSessionId; state.kind = kind; }
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
  const parent = io.header(source);

  if (!Check(sessionIdSchema, parent?.id)) throw new Error("Conversation has no session ID");

  return parent;
}

async function collectArea(root, area) {
  const directory = path.join(root, area);

  return io.exists(directory) ? collect(directory) : [];
}

async function migrate(root) {
  const sessions = [...await collectArea(root, "sessions"), ...await collectArea(root, "archived")];
  const indexes = new Map();

  for (const session of sessions) {
    if (!Check(sessionIdSchema, session.id) || indexes.has(session.id)) throw new Error("Conversation lineage has missing or ambiguous identities");
    const previous = childIndex.read(root, session.id);
    indexes.set(session.id, { version: 1, sessionId: session.id, sessionPath: session.file, complete: true, children: previous?.children ?? [] });
  }

  for (const session of sessions) {
    const parent = indexes.get(session.parent);

    if (!parent || !session.kind) continue;
    const children = new Map(parent.children.map(child => [child.sessionId, child]));
    children.set(session.id, { sessionId: session.id, sessionPath: session.file, kind: session.kind });
    parent.children = [...children.values()];
  }

  childIndex.beginMigration(root);

  for (const index of indexes.values()) childIndex.store(root, index);

  childIndex.finishMigration(root);
}

function allowedPath(root, file) {
  return io.inside(path.join(root, "sessions"), file) || io.inside(path.join(root, "archived"), file);
}

function resolveChild(root, child) {
  if (io.deleted(root, child.sessionId)) return;
  const indexed = childIndex.read(root, child.sessionId);

  for (const file of new Set([indexed?.sessionPath, child.sessionPath])) {
    if (!file || !allowedPath(root, file)) continue;

    if (io.header(file)?.id === child.sessionId) return file;
  }

  const located = io.locate(root, child.sessionId);

  if (located) childIndex.ensure(root, child.sessionId, located.path);

  return located?.path;
}

function descendants(root, parentId, args) {
  if (io.exists(childIndex.migrationPath(root))) throw new MissingChildIndex();
  const traversal = { seen: new Set([parentId]), queue: [parentId], result: [] };

  for (let cursor = 0; cursor < traversal.queue.length; cursor++) {
    const index = childIndex.read(root, traversal.queue[cursor]);

    if (!index?.complete) throw new MissingChildIndex();
    appendChildren(root, index, traversal, args);
  }

  return traversal.result;
}

function appendChildren(root, index, traversal, args) {
  const missing = new Set();

  for (const child of index.children) {
    if (traversal.seen.has(child.sessionId)) continue;
    traversal.seen.add(child.sessionId);
    const file = resolveChild(root, child);

    if (!file) { missing.add(child.sessionId); continue; }

    const archived = io.inside(path.join(root, "archived"), file);

    if (!args.includeOtherArea && archived !== Boolean(args.archived)) continue;
    traversal.result.push(args.includeOtherArea ? [file, archived] : file);
    traversal.queue.push(child.sessionId);
  }

  if (missing.size) {
    index.children = index.children.filter(child => !missing.has(child.sessionId));
    childIndex.store(root, index);
  }
}

async function main() {
  const args = JSON.parse(process.argv[1]);
  const area = args.archived ? "archived" : "sessions";
  const root = await fs.realpath(args.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", area));
  const source = await fs.realpath(args.path);
  const parent = await validatedParent(root, source);
  const profile = path.dirname(root);

  const children = await io.lockedAsync(profile, async () => {
    try { return descendants(profile, parent.id, args); }
    catch (error) { if (!(error instanceof MissingChildIndex)) throw error; }

    await migrate(profile);

    return descendants(profile, parent.id, args);
  });

  process.stdout.write(JSON.stringify(children));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
