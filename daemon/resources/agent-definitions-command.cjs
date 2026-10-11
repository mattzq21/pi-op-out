const { hostScript } = require('./host-script.cjs');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');

async function load(request) {
  const { home, storage, settings, initial, extensionRoot, pi, cwd } = request;
  const response = randomUUID();
  Object.assign(process.env, {
    HOME: home, PIOP_BUN: process.execPath, PIOP_STORAGE_DIRECTORY: storage,
    PI_CODING_AGENT_DIR: join(home, storage), PIOP_AGENT_CONFIG_PATH: join(home, storage, 'piop-define-agents/config.json'),
    PIOP_AGENT_RESPONSE_ID: response, PIOP_GENERATED_EXTENSION_ROOT: extensionRoot, PIOP_PI_EXECUTABLE: pi, PIOP_AGENT_INITIAL_LOAD: initial ? '1' : '0',
  });
  process.chdir(cwd);
  process.argv[2] = JSON.stringify(settings);
  const write = process.stdout.write;
  const chunks = [];
  let bytes = 0;
  process.stdout.write = function(chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
    bytes += buffer.length;
    if (bytes > 16 * 1024 * 1024) throw new Error('Agent definitions output exceeded its limit');
    chunks.push(buffer);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  const prefix = response + ':';
  let lines;
  try {
    await import('data:text/javascript;base64,' + gunzipSync(Buffer.from(__PIOP_AGENT_LOADER__, 'base64')).toString('base64'));
  } finally {
    process.stdout.write = write;
    lines = Buffer.concat(chunks).toString().split('\n');
    for (const item of lines) if (item && !item.startsWith(prefix)) console.error(item);
  }
  const line = lines.findLast(item => item.startsWith(prefix));
  if (line === undefined) throw new Error('Agent definitions response is missing');
  return JSON.parse(line.slice(prefix.length));
}

hostScript(load).then(() => process.stdout.end(() => process.exit(process.exitCode ?? 0)));
