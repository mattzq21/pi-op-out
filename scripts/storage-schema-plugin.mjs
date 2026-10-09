import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export function storageSchemaImports() {
  return { name: "storage-schema-imports", setup(build) {
    build.onResolve({ filter: /\.cjs\?storage-export=[\w,]+$/ }, args => ({ path: resolve(args.resolveDir, args.path), namespace: "storage-export" }));
    build.onLoad({ filter: /.*/, namespace: "storage-export" }, ({ path }) => {
      const [module, names] = path.split("?storage-export=");

      return { contents: `export { ${names} } from ${JSON.stringify(module)};`, loader: "js", resolveDir: dirname(module) };
    });
    build.onLoad({ filter: /\.cjs$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const values = /const \{ ([A-Z]\w*(?:, [A-Z]\w*)*) \} = require\(["']typebox\/value["']\);/g;
      const contents = lazyImports(canonicalImports(schemaImports(source), path), path).replace(values, (_declaration, names) => `import { ${names} } from "typebox/value";`);

      if (contents === source) return;

      return { contents, loader: "js" };
    });
  } };
}

const canonicalModules = new Set([
  "snapshot-operation-stores.cjs",
  "archive-checkpoints.cjs", "archive-legacy-recovery.cjs", "archive-resource-migration.cjs", "archive-resource-owners.cjs", "archive-resource-restore.cjs", "archive-resource-transactions.cjs", "archive-resources.cjs", "archive-transaction.cjs",
  "checkpoint-schemas.cjs", "delete-recovery.cjs", "delete-transaction.cjs", "deletion-retention.cjs", "directory-liveness.cjs", "fork-preparation.cjs", "fork-transaction.cjs", "goal-asset-cleanup.cjs", "registry-deletion.cjs",
  "restore-receipts.cjs", "restore-transaction.cjs", "retention-candidates.cjs", "retention-collection.cjs", "session-diff-store.cjs", "session-transactions.cjs", "snapshot-recovery.cjs", "storage-lock.cjs", "storage-recovery.cjs", "storage-transaction-lock.cjs",
  "transaction-owner-locks.cjs", "transcript-identity.cjs", "worktree-checkpoint-preservation.cjs", "worktree-container.cjs", "worktree-retention.cjs",
  "git-diff-migration.cjs", "git-diff-store.cjs", "git-diff-pages.cjs", "git-diff-transfer.cjs", "session-publication.cjs", "session-publication-io.cjs", "session-publication-dependencies.cjs", "session-child-index.cjs", "checkpoint-owner-index.cjs", "review-publication.cjs", "goal-assets.cjs",
]);

function canonicalImports(source, path) {
  if (!path.includes("/daemon/resources/")) return source;

  const modules = /^const (\{ [\w,: ]+ \}|\w+) = require\((["'])([^"']+\.cjs)\2\);/gm;

  const imports = source.replace(modules, (declaration, binding, _quote, module) => {
    if (!canonicalModules.has(basename(module))) return declaration;

    return binding.startsWith("{") ? `import ${binding.replaceAll(":", " as ")} from ${JSON.stringify(module)};` : `import * as ${binding} from ${JSON.stringify(module)};`;
  });

  if (!canonicalModules.has(basename(path))) return imports;

  return imports.replace(/^module\.exports = \{ ([\w,: ]+) \};$/m, (_declaration, properties) => {
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
