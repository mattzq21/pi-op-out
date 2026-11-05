// Tests load the daemon's source with Bun's own module loader. That loader fails when a CommonJS file requires typebox
// while an ES module import of typebox is still loading. Loading typebox once, before the tests, avoids it.
// The daemon itself is one esbuild bundle and does not need this.
require('typebox');
require('typebox/value');

// The daemon's built-in plugins come from its build. Daemon code that tests load from source gets their manifests instead.
const { join } = require('node:path');
Bun.plugin({
  name: 'builtin-plugins',
  target: 'bun',
  setup(build) { build.module('piop-builtin-plugins', () => ({ exports: { default: require(join(__dirname, '../builtin-plugins.mjs')).default }, loader: 'object' })); },
});
