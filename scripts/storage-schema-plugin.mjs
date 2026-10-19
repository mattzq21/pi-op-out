import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function storageSchemaImports() {
  return { name: "storage-schema-imports", setup(build) {
    build.onResolve({ filter: /^\.\.\/app-settings\.cjs$/ }, args => {
      if (!args.importer.includes('/extensions/piop-define-agents/')) return;

      return { path: fileURLToPath(new URL('../daemon/resources/session-broker/app-settings.cjs', import.meta.url)) };
    });
    build.onResolve({ filter: /\.cjs\?storage-export=[\w,]+$/ }, args => ({ path: resolve(args.resolveDir, args.path), namespace: "storage-export" }));
    build.onLoad({ filter: /.*/, namespace: "storage-export" }, ({ path }) => {
      const [module, names] = path.split("?storage-export=");

      return { contents: `export { ${names} } from ${JSON.stringify(module)};`, loader: "js", resolveDir: dirname(module) };
    });
    build.onLoad({ filter: /\.cjs$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");

      if (basename(path) === 'app-settings.cjs') return { contents: source
        .replace("const fs = require('node:fs');", "import fs from 'node:fs';")
        .replace("const path = require('node:path');", "import path from 'node:path';")
        .replace("const { DatabaseSync } = require('node:sqlite');", "import { DatabaseSync } from 'node:sqlite';")
        .replace('module.exports = { read, readFile, readText, write };', 'export { read, readFile, readText, write };'), loader: 'js' };

      const values = /const \{ ([A-Z]\w*(?:, [A-Z]\w*)*) \} = require\(["']typebox\/value["']\);/g;
      const contents = lazyImports(canonicalImports(schemaImports(source), path), path).replace(values, (_declaration, names) => `import { ${names} } from "typebox/value";`);

      if (contents === source) return;

      return { contents, loader: "js" };
    });
  } };
}

const canonicalModules = new Set([
  "file-lock.cjs", "session-records.cjs",
  "external-transcripts.cjs", "transcript-metadata.cjs", "conversation-storage.cjs",
  "session-database.cjs", "temporary-chat.cjs", "transcript-references.cjs", "goal-dependencies.cjs", "goal-preparations.cjs", "goal-ownership.cjs",

  "archive-plan.cjs", "storage-transaction.cjs", "deletion-retention.cjs", "goal-asset-cleanup.cjs", "registry-deletion.cjs",
  "restore-receipts.cjs", "restore-plan.cjs", "retention-candidates.cjs", "retention-collection.cjs", "session-transactions.cjs", "reference-publication-lock.cjs",
  "transcript-identity.cjs",
  "session-publication.cjs", "session-publication-io.cjs", "session-publication-dependencies.cjs", "session-child-index.cjs", "review-publication.cjs", "goal-assets.cjs",
]);

function canonicalImports(source, path) {
  if (!path.includes("/daemon/resources/")) return source;

  const modules = /^const (\{ [\w,: ]+ \}|\w+) = require\((["'])([^"']+\.cjs)\2\);/gm;

  const imports = source.replace(modules, (declaration, binding, _quote, module) => {
    if (!canonicalModules.has(basename(module))) return declaration;

    return binding.startsWith("{") ? `import ${binding.replaceAll(":", " as ")} from ${JSON.stringify(module)};` : `import * as ${binding} from ${JSON.stringify(module)};`;
  });

  if (!canonicalModules.has(basename(path))) return imports;

  const native = imports.replace(/^const (\{ [\w,: ]+ \}|\w+) = require\((["'])(node:[^"']+)\2\);/gm, (_declaration, binding, _quote, module) => binding.startsWith("{") ? `import ${binding.replaceAll(":", " as ")} from ${JSON.stringify(module)};` : `import * as ${binding} from ${JSON.stringify(module)};`);

  return native.replace(/^module\.exports = \{ ([\w,:\s]+) \};$/m, (_declaration, properties) => {
    const names = properties.split(",").map(property => {
      const [exported, local] = property.trim().split(/:\s*/);

      return local ? `${local} as ${exported}` : exported;
    });

    return `export { ${names.join(", ")} };`;
  });
}

function lazyImports(source, path) {
  if (!path.includes("/daemon/resources/")) return source;

  const destructured = /const \{ ([\w, ]+) \} = require\((["'])([^"']+\.cjs)\2\);/g;

  const imports = source.replace(destructured, (declaration, names, _quote, module) => {
    if (!canonicalModules.has(basename(module))) return declaration;

    return `const { ${names} } = require(${JSON.stringify(`${module}?storage-export=${names.replaceAll(" ", "")}`)});`;
  });

  return imports.replace(/require\((["'])([^"']+\.cjs)\1\)\.(\w+)/g, (expression, _quote, module, name) => {
    if (!canonicalModules.has(basename(module))) return expression;

    return `require(${JSON.stringify(`${module}?storage-export=${name}`)}).${name}`;
  });
}

function schemaImports(source) {
  const declaration = /const \{ Type \} = require\(["']typebox["']\);/;

  if (!declaration.test(source)) return source;
  const names = [...new Set([...source.matchAll(/\bType\.([A-Z]\w*)/g)].map(match => match[1]))].sort();
  const remaining = source.replace(declaration, "").replace(/\bType\.[A-Z]\w*/g, "");

  if (!names.length || /\bType\b/.test(remaining)) return source;
  const imports = names.map(name => `${name} as StorageSchema${name}`).join(", ");

  return source.replace(declaration, `import { ${imports} } from "typebox";`).replace(/\bType\.([A-Z]\w*)/g, "StorageSchema$1");
}
