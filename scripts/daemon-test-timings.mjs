import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

async function read(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  try {
    const value = JSON.parse(text);
    if (value.version !== 1 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)
      || Object.values(value.files).some(time => !Number.isFinite(time) || time < 0)) throw new Error('Invalid durations');
    return value.files;
  } catch (error) {
    console.warn(`Ignoring invalid daemon test timings in ${path}: ${error.message}`);
    return {};
  }
}

export async function daemonTestTimings(files, workingPath, savedPath) {
  const saved = await read(savedPath);
  const selected = await Promise.all(files.map(async file => {
    const key = relative(process.cwd(), resolve(file));
    return [key, saved[key] ?? (await stat(file)).size];
  }));
  await writeFile(workingPath, JSON.stringify({ version: 1, files: Object.fromEntries(selected) }));
  return async () => {
    const measured = await read(workingPath);
    const current = await read(savedPath);
    for (const [key] of selected) if (Object.hasOwn(measured, key)) current[key] = measured[key];
    await mkdir(dirname(savedPath), { recursive: true });
    const temporary = savedPath + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, files: current }), { flag: 'wx' });
      await rename(temporary, savedPath);
    } finally { await rm(temporary, { force: true }); }
  };
}
