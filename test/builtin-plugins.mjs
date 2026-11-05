import { existsSync, readdirSync, readFileSync } from 'node:fs';

// The built-in plugins for daemon code that unit tests load without the daemon build: their manifests, and stand-ins for
// their built parts.
const folder = new URL('../plugins/', import.meta.url);

export default readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().map(id => ({
  manifest: readFileSync(new URL(`${id}/plugin.json`, folder), 'utf8'),
  ...existsSync(new URL(`${id}/extension/index.ts`, folder)) ? { extension: '// Unit tests do not build plugin extensions.\n' } : {},
  ...existsSync(new URL(`${id}/client/index.tsx`, folder)) ? { client: '// Unit tests do not build plugin client parts.\n' } : {},
}));
