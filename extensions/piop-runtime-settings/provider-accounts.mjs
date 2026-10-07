import { readFile as accountRead, mkdir as accountMkdir } from 'node:fs/promises';
import { spawn as accountSpawn } from 'node:child_process';
import { dirname as accountDirname, join as accountJoin } from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';

const accountSchema = Type.Object({ providerId: Type.String(), number: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }), id: Type.String() });

const messageSchema = Type.Object({ role: Type.Literal('assistant') });

export const providerAccountsPath = (authPath) => `${authPath}.piop-accounts.json`;

export async function readProviderAccounts(authPath) {
  try {
    const records = JSON.parse(await accountRead(providerAccountsPath(authPath), 'utf8'));

    if (!Array.isArray(records) || records.some((record) => !validProviderAccount(record))) throw new Error('Invalid provider account registry');

    return records;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function validProviderAccount(record) {
  return Check(accountSchema, record) && record.id === `${record.providerId}--piop-account-${record.number}`;
}

export async function allocateProviderAccount(authPath, providerId, occupied) {
  await accountMkdir(accountDirname(authPath), { recursive: true, mode: 0o700 });
  await readProviderAccounts(authPath);

  const script = `
    const fs = require('node:fs');
    const [path, providerId, occupiedJson] = process.argv.slice(1);
    let records = [];
    try { records = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const occupied = new Set(JSON.parse(occupiedJson));
    let number = Math.max(1, ...records.filter(item => item.providerId === providerId).map(item => item.number)) + 1;
    while (occupied.has(providerId + '--piop-account-' + number)) number++;
    const record = { providerId, number, id: providerId + '--piop-account-' + number };
    records.push(record);
    const temporary = path + '.' + require('node:crypto').randomUUID();
    const file = fs.openSync(temporary, 'wx', 0o600);
    try {
      try { fs.writeFileSync(file, JSON.stringify(records)); fs.fsyncSync(file); }
      finally { fs.closeSync(file); }
      fs.renameSync(temporary, path);
    } finally { fs.rmSync(temporary, { force: true }); }
    const directory = fs.openSync(require('node:path').dirname(path), 'r');
    try { fs.fsyncSync(directory); }
    finally { fs.closeSync(directory); }
    process.stdout.write(JSON.stringify(record));
  `;

  const path = providerAccountsPath(authPath);

  return new Promise((resolve, reject) => {
    const child = accountSpawn('flock', ['--exclusive', '--wait', '10', `${path}.lock`, process.execPath, '-e', script, path, providerId, JSON.stringify(occupied)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', () => reject(new Error('Could not allocate a provider account. The host requires flock.')));
    child.once('close', (code) => {
      if (code !== 0) { reject(new Error('Could not save the provider account on this host'));

      return; }

      try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid provider account allocation')); }
    });
  });
}

export function accountProvider(base, record) {
  const model = (value) => ({ ...value, provider: record.id });
  const original = (value) => ({ ...value, provider: base.id });
  const apiKey = base.auth.apiKey && { ...base.auth.apiKey, resolve: (input) => input.credential ? base.auth.apiKey.resolve(input) : undefined };

  if (apiKey?.check) apiKey.check = (input) => input.credential ? base.auth.apiKey.check(input) : undefined;
  const originalContext = (context) => ({ ...context, messages: context.messages.map((message) => message.provider === record.id ? { ...message, provider: base.id } : message) });

  const provider = {
    ...base, id: record.id, name: `${base.name} #${record.number}`, auth: { ...base.auth, apiKey },
    getModels: () => base.getModels().map(model),
    stream: (value, context, options) => accountStream(base.stream(original(value), originalContext(context), options), record.id),
    streamSimple: (value, context, options) => accountStream(base.streamSimple(original(value), originalContext(context), options), record.id),
  };

  if (base.filterModels) provider.filterModels = (models, credential) => base.filterModels(models.map(original), credential).map(model);

  if (base.refreshModels) provider.refreshModels = (context) => base.refreshModels(context);

  if (base.fetchDeferred) provider.fetchDeferred = (value, handle, options) => accountStream(base.fetchDeferred(original(value), handle, options), record.id);

  if (base.cancelDeferred) provider.cancelDeferred = (value, handle, options) => base.cancelDeferred(original(value), handle, options);

  return provider;
}

function accountStream(source, provider) {
  const message = (value) => value ? { ...value, provider } : value;

  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        const next = { ...event };

        for (const field of ['partial', 'message', 'error']) if (Check(messageSchema, next[field])) next[field] = message(next[field]);
        yield next;
      }
    },
    result: async () => message(await source.result()),
  };
}

const accountConfigurations = new WeakMap();

export async function loadAccountProviders(authPath, createRuntime, existing = new Map()) {
  const records = await readProviderAccounts(authPath);

  const configuration = await accountRead(accountJoin(accountDirname(authPath), 'models.json'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });

  for (const record of records) {
    if (existing.has(record.id) && accountConfigurations.get(existing.get(record.id)) === configuration) continue;
    const runtime = await createRuntime();
    const base = runtime.getProvider(record.providerId);

    if (base) {
      const provider = accountProvider(base, record);
      accountConfigurations.set(provider, configuration);
      existing.set(record.id, provider);
    }
  }

  return existing;
}
