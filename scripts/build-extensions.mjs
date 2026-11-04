import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildArtifact, reportUnchanged } from "./incremental-build.mjs";

async function agentCommandInventory(files) {
  const names = new Set();

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "registerCommand") {
      const name = node.arguments[0];

      if (name && ts.isStringLiteral(name)) names.add(name.text);
    }

    ts.forEachChild(node, visit);
  }

  for (const path of files) visit(ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest));

  return [...names].sort();
}

async function backendScripts() {
  const commandInputs = [];

  for (const root of ["extensions", "daemon/resources"]) {
    for (const path of await readdir(root, { recursive: true })) {
      if (path.endsWith(".ts") && !path.includes("node_modules")) commandInputs.push(join(root, path));
    }
  }

  commandInputs.sort();

  await buildArtifact({
    output: "daemon/resources/agent-commands.json",
    inputs: [fileURLToPath(import.meta.url), ...commandInputs],
    key: "agent-command-inventory",
  }, async () => ({ content: `${JSON.stringify(await agentCommandInventory(commandInputs), null, 2)}\n` }));

}

await backendScripts();

reportUnchanged();
