import { readFile } from "node:fs/promises";

export function storageSchemaImports() {
  return { name: "storage-schema-imports", setup(build) {
    build.onLoad({ filter: /\.cjs$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const values = /const \{ ([A-Z]\w*(?:, [A-Z]\w*)*) \} = require\(["']typebox\/value["']\);/g;
      const contents = canonicalImports(schemaImports(source), path).replace(values, (_declaration, names) => `import { ${names} } from "typebox/value";`);

      if (contents === source) return;

      return { contents, loader: "js" };
    });
  } };
}

const canonicalModules = new Set(["git-diff-store.cjs", "git-diff-pages.cjs", "git-diff-transfer.cjs", "session-publication.cjs", "session-publication-io.cjs", "session-publication-dependencies.cjs", "review-publication.cjs", "goal-assets.cjs", "archive-resources.cjs", "archive-resource-owners.cjs", "session-transactions.cjs", "transcript-identity.cjs"]);

function canonicalImports(source, path) {
  if (!path.includes("/src-tauri/resources/")) return source;

  const modules = /^const (\{ [\w, ]+ \}|\w+) = require\((["'])([^"']+\.cjs)\2\);/gm;

  const imports = source.replace(modules, (declaration, binding, _quote, module) => {
    if (!canonicalModules.has(module.split("/").at(-1))) return declaration;

    return binding.startsWith("{") ? `import ${binding} from ${JSON.stringify(module)};` : `import * as ${binding} from ${JSON.stringify(module)};`;
  });

  if (!canonicalModules.has(path.split("/").at(-1))) return imports;

  return imports.replace(/^module\.exports = \{ ([\w,: ]+) \};$/m, (_declaration, properties) => {
    const names = properties.split(",").map(property => {
      const [exported, local] = property.trim().split(/:\s*/);

      return local ? `${local} as ${exported}` : exported;
    });

    return `export { ${names.join(", ")} };`;
  });
}

function schemaImports(source) {
  const declaration = /const \{ Type \} = require\(["']typebox["']\);/;

  if (!declaration.test(source)) return source;
  const names = [...new Set([...source.matchAll(/\bType\.([A-Z]\w*)/g)].map(match => match[1]))].sort();
  const remaining = source.replace(declaration, "").replace(/\bType\.[A-Z]\w*/g, "");

  if (!names.length || /\bType\b/.test(remaining)) return source;
  const imports = names.map(name => `${name} as StorageSchema${name}`).join(", ");
  const properties = names.map(name => `${name}: StorageSchema${name}`).join(", ");

  return source.replace(declaration, `import { ${imports} } from "typebox"; const Type = { ${properties} };`);
}
