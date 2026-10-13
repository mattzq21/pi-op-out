import { build } from 'esbuild';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storageSchemaImports } from '../scripts/storage-schema-plugin.mjs';

export async function installFastMode(t, { dir, pi, ctx, models, catalog, fastModels }) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/fast-models' ? { data: fastModels ?? { ready: true, providers: Object.fromEntries([...new Set(models.map(model => model.provider))].map(provider => [provider, { supportedModelIds: catalog.filter(model => model.service_tiers?.some(tier => tier.id === 'priority')).map(model => model.slug) }])) } } : { models: catalog }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  for (const model of models) model.baseUrl = baseUrl;
  ctx.modelRegistry.getAvailable = () => models;
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'fixture-key', headers: {} });
  ctx.hasUI = true;
  ctx.mode = 'rpc';
  const brokerKeys = ['PI_DESKTOP_BROKER_URL', 'PI_DESKTOP_BROKER_TOKEN'];
  const previous = brokerKeys.map(key => process.env[key]);
  process.env.PI_DESKTOP_BROKER_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.PI_DESKTOP_BROKER_TOKEN = 'fixture-token';
  t.after(() => brokerKeys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }));
  const outfile = join(dir, 'real-fast-mode.mjs');
  await build({
    entryPoints: ['extensions/piop-openai-fast-mode/src/index.ts'], outfile,
    bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
    plugins: [storageSchemaImports(), { name: 'external-pi-sdk', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const getAgentDir = () => ${JSON.stringify(dir)};` }));
    } }],
  });
  const { createPiFastModeExtension } = await import(pathToFileURL(outfile));
  const register = () => createPiFastModeExtension({ extensionDir: dir, agentDir: dir })(pi);
  register();
  return register;
}
