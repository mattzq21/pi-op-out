const fs = require("node:fs/promises");
const { Type } = require("typebox");
const { Check } = require("typebox/value");

const sessionIdSchema = Type.String();

const path = require("node:path");
const os = require("node:os");
const io = require("./session-broker/session-publication-io.cjs");
const childIndex = require("./session-broker/session-child-index.cjs");

async function validatedParent(root, source) {
  const relative = path.relative(root, source);

  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !source.endsWith(".jsonl")) throw new Error("Invalid conversation path");
  const parent = io.header(source);

  if (!Check(sessionIdSchema, parent?.id)) throw new Error("Conversation has no session ID");

  return parent;
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
  const traversal = { seen: new Set([parentId]), queue: [parentId], result: [] };

  for (let cursor = 0; cursor < traversal.queue.length; cursor++) {
    const index = childIndex.read(root, traversal.queue[cursor]);

    if (!index) continue;
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

  const children = await io.lockedAsync(profile, () => descendants(profile, parent.id, args));

  process.stdout.write(JSON.stringify(children));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
