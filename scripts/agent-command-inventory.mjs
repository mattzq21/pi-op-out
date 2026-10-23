import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

export async function agentCommandInputs() {
  const files = [];

  for (const root of ["extensions", "daemon/resources"]) {
    for (const path of await readdir(root, { recursive: true })) {
      if (path.endsWith(".ts") && !path.includes("node_modules")) files.push(join(root, path));
    }
  }

  return files.sort();
}

export async function agentCommandInventory(files) {
  files ??= await agentCommandInputs();
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
