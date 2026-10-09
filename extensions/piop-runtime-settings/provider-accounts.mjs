import { storedModelText } from '../../daemon/resources/sdk-storage.mjs';
import * as accountFs from 'node:fs';
import { DatabaseSync as AccountDatabase } from 'node:sqlite';
import { dirname as accountDirname, join as accountJoin, basename as accountBasename } from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';


const accountSchema = Type.Object({ providerId: Type.String(), number: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }), id: Type.String() });

function validProviderAccount(record) {
  return Check(accountSchema, record) && record.id === `${record.providerId}--piop-account-${record.number}`;
}

const messageSchema = Type.Object({ role: Type.Literal('assistant') });

export const providerAccountsPath = (authPath) => `${authPath}.piop-accounts.json`;

function withAccountDatabase(authPath, operation) {
  const directory = accountDirname(authPath);
  accountFs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = accountJoin(directory, 'piop-accounts.sqlite');
  accountFs.closeSync(accountFs.openSync(file, accountFs.constants.O_CREAT | accountFs.constants.O_RDWR | accountFs.constants.O_NOFOLLOW, 0o600));
  accountFs.chmodSync(file, 0o600);
  const db = new AccountDatabase(file);
  const key = accountBasename(authPath);

  try {
    db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS provider_accounts (
        auth_file TEXT NOT NULL, provider_id TEXT NOT NULL, account_number INTEGER NOT NULL, id TEXT NOT NULL,
        PRIMARY KEY(auth_file, id), UNIQUE(auth_file, provider_id, account_number));
      BEGIN IMMEDIATE;`);
    const result = operation(db, key);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

export async function readProviderAccounts(authPath) {
  return withAccountDatabase(authPath, (db, key) => db.prepare('SELECT provider_id AS providerId, account_number AS number, id FROM provider_accounts WHERE auth_file=? ORDER BY rowid').all(key));
}

export async function allocateProviderAccount(authPath, providerId, occupied) {
  return withAccountDatabase(authPath, (db, key) => {
    const maximum = db.prepare('SELECT COALESCE(MAX(account_number), 1) AS number FROM provider_accounts WHERE auth_file=? AND provider_id=?').get(key, providerId).number;
    const unavailable = new Set(occupied);
    let number = maximum + 1;

    while (Number.isSafeInteger(number) && unavailable.has(`${providerId}--piop-account-${number}`)) number++;

    if (!Number.isSafeInteger(number)) throw new Error('Provider account numbers are exhausted');
    const record = { providerId, number, id: `${providerId}--piop-account-${number}` };

    if (!validProviderAccount(record)) throw new Error('Invalid provider account allocation');
    db.prepare('INSERT INTO provider_accounts VALUES (?, ?, ?, ?)').run(key, providerId, number, record.id);

    return record;
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

  const configuration = storedModelText(accountJoin(accountDirname(authPath), 'models.json')) ?? '';

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
