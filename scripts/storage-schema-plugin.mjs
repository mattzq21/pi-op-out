import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

// The storage modules that become ES modules in a build, by path in daemon/resources/.
const canonicalModules = new Set([
  "piop-storage/session-records.cjs",
  "external-transcripts.cjs", "transcript-metadata.cjs", "conversation-storage.cjs",
  "session-database.cjs", "session-database/core.cjs", "session-database/registry.cjs", "session-database/storage.cjs", "session-database/goals.cjs",
  "session-database/queue.cjs", "session-database/transcripts.cjs", "session-database/settings.cjs",
  "temporary-chat.cjs", "transcript-references.cjs", "piop-storage/goal-dependencies.cjs", "piop-storage/goal-preparations.cjs", "piop-storage/goal-ownership.cjs",

  "archive-plan.cjs", "storage-transaction.cjs", "piop-storage/deletion-retention.cjs", "piop-storage/goal-asset-cleanup.cjs", "registry-deletion.cjs",
  "restore-receipts.cjs", "restore-plan.cjs", "piop-storage/retention-candidates.cjs", "piop-storage/retention-collection.cjs", "session-transactions.cjs",
  "piop-storage/reference-publication-lock.cjs", "transcript-identity.cjs", "storage-channel.cjs", "main-thread.cjs", "application-records.cjs",
  "piop-storage/session-publication.cjs", "piop-storage/session-publication-io.cjs", "piop-storage/session-publication-dependencies.cjs",
  "session-broker/session-child-index.cjs", "session-broker/session-names.cjs", "piop-storage/goal-assets.cjs",
]);

const RESOURCES = "/daemon/resources/";

// True when file, or module as required from file, is a canonical storage module.
function canonical(file, module) {
  const target = module === undefined ? file : resolve(dirname(file), module);
  const at = target.lastIndexOf(RESOURCES);

  return at !== -1 && canonicalModules.has(target.slice(at + RESOURCES.length));
}

function bindingImport(binding, module) {
  return binding.startsWith("{") ? `import { ${names(binding.slice(1, -1)).join(", ")} } from ${JSON.stringify(module)};` : `import * as ${binding} from ${JSON.stringify(module)};`;
}

function names(list) {
  return list.split(",").map(name => name.trim()).filter(Boolean).map(name => name.replace(/\s*:\s*/, " as "));
}

function canonicalImports(source, path) {
  if (!path.includes(RESOURCES)) return source;

  const modules = /^const (\{[\w,:\s]+\}|\w+) = require\((["'])([^"']+\.cjs)\2\);/gm;

  const imports = source.replace(modules, (declaration, binding, _quote, module) => canonical(path, module) ? bindingImport(binding, module) : declaration);

  if (!canonical(path)) return imports;

  const native = imports.replace(/^const (\{[\w,:\s]+\}|\w+) = require\((["'])(node:[^"']+)\2\);/gm, (_declaration, binding, _quote, module) => bindingImport(binding, module));

  return native.replace(/^module\.exports = \{([\w,:.\s'"()/-]+)\};$/m, (declaration, properties) => {
    const spreads = [];
    const local = properties.replace(/\.\.\.require\((["'])([^"']+\.cjs)\1\)/g, (_spread, _quote, module) => { spreads.push(module); return ""; });

    if (/[.'"()]/.test(local)) return declaration;
    const exported = names(local).map(name => {
      const [outer, inner] = name.split(" as ");

      return inner ? `${inner} as ${outer}` : outer;
    });

    return [`export { ${exported.join(", ")} };`, ...spreads.map(module => `export * from ${JSON.stringify(module)};`)].join("\n");
  });
}

function lazyImports(source, path) {
  if (!path.includes(RESOURCES)) return source;

  const destructured = /const \{([\w,\s]+)\} = require\((["'])([^"']+\.cjs)\2\);/g;

  const imports = source.replace(destructured, (declaration, list, _quote, module) => {
    if (!canonical(path, module)) return declaration;
    const bound = names(list);

    return `const { ${bound.join(", ")} } = require(${JSON.stringify(`${module}?storage-export=${bound.join(",")}`)});`;
  });

  return imports.replace(/require\((["'])([^"']+\.cjs)\1\)\.(\w+)/g, (expression, _quote, module, name) => {
    if (!canonical(path, module)) return expression;

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
