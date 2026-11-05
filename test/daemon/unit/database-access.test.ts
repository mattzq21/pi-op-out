import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Each database has one owner module. Only the owner opens it and has SQL; all other code calls the owner's functions.
const project = join(import.meta.dir, '../../..');

const DATABASE = 'daemon/resources/session-database/';

const OWNERS = [
  DATABASE,
  // The phone's own client settings database.
  'clients/android/app/src/main/java/dev/pi/mobile/ClientPreferencesStorage.java',
];

const SOURCE = /\.(ts|tsx|js|mjs|cjs|rs|py|kt|java|sh)$/;

const ACCESS = /node:sqlite|bun:sqlite|better-sqlite3|rusqlite|\bsqlite3\b|\b(SELECT\s+[A-Za-z_*(]|INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|UNIQUE)|DROP\s+TABLE|PRAGMA\s+\w)/;

const sources = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: project, encoding: 'utf8' })
  .split('\n').filter(file => SOURCE.test(file) && !file.startsWith('test/'));

const text = (file: string) => { try { return readFileSync(join(project, file), 'utf8'); } catch { return ''; } };

test('only the owner module of a database opens it or has SQL', () => {
  const outside = sources.filter(file => !OWNERS.some(owner => file.startsWith(owner)) && ACCESS.test(text(file)));
  expect(outside).toEqual([]);
});

test('code outside the storage database imports only its index.ts', () => {
  const inner = /session-database\/(?!index(\.ts)?['"])[\w-]+(\.ts)?['"]/;
  const outside = sources.filter(file => !file.startsWith(DATABASE) && inner.test(text(file)));
  expect(outside).toEqual([]);
});

test('plugins and Pi extensions do not use the storage database module', () => {
  const outside = sources.filter(file => /^(plugins|pi-extensions)\//.test(file) && /session-database(\/index)?(\.ts)?['"]/.test(text(file)));
  expect(outside).toEqual([]);
});
