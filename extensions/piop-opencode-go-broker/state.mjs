import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(import.meta.url);

// Executed under flock in a separate process so crashes release the lock.
async function transaction() {
  const fs = await import('node:fs/promises');
  const { randomUUID, createHash } = await import('node:crypto');
  const path = process.argv[3];
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  const now = Date.now();
  async function readState() {
    let value = { version: 1, accounts: {}, sessions: {}, leases: {} };
    try { value = JSON.parse(await fs.readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (value.version !== 1 || !value.accounts || !value.sessions || !value.leases) throw new Error('Invalid Go broker state');
    return value;
  }
  const state = await readState();
  function prune() {
    for (const [id, lease] of Object.entries(state.leases)) if (lease.expires <= now) delete state.leases[id];
    for (const [id, session] of Object.entries(state.sessions)) if (session.touched < now - 90 * 86400000) delete state.sessions[id];
  }
  prune();

  function headroom(account) {
    const windows = account.usage ? Object.values(account.usage) : [];
    return Math.min(1, ...windows.map(window => {
      if (window.resetsAt && Date.parse(window.resetsAt) <= now) return 1;
      return window.status === 'rate-limited' ? 0 : 1 - window.percent / 100;
    }));
  }
  function eligible(id) {
    const account = state.accounts[id] || {};
    return !request.excluded.includes(id) && !(account.blockedUntil > now) && headroom(account) > 0;
  }
  function score(id) {
    const active = Object.values(state.leases).filter(lease => lease.account === id).length;
    const recent = Object.values(state.sessions).filter(session => session.account === id && session.touched > now - 900000).length;
    const account = state.accounts[id] || {};
    const confidence = account.checked > now - 300000 ? 1 : 0.1;
    return (1 + active + recent) / (Math.max(0.01, headroom(account)) * confidence);
  }
  function tie(id) { return createHash('sha256').update(request.session + id).digest('hex'); }
  function acquire() {
    for (const update of request.updates) {
      const account = state.accounts[update.id] ||= {};
      if (update.checked >= (account.checked || 0)) Object.assign(account, { checked: update.checked, usage: update.usage });
    }
    const candidates = request.accounts.filter(eligible);
    const existing = state.sessions[request.session]?.account;
    const account = candidates.includes(existing) ? existing : candidates.sort((a, b) => score(a) - score(b) || tie(a).localeCompare(tie(b)))[0];
    if (!account) throw new Error('All OpenCode Go accounts are exhausted or unavailable. Check account usage and reset times.');
    state.sessions[request.session] = { account, touched: now };
    state.leases[request.lease] = { account, expires: now + 120000 };
    return { account };
  }
  function release() {
    delete state.leases[request.lease];
    if (request.cooldown) {
      const account = state.accounts[request.account] ||= {};
      account.blockedUntil = Math.max(account.blockedUntil || 0, now + request.cooldown);
      account.checked = 0;
    }
  }
  function dispatch() {
    switch (request.action) {
      case 'snapshot': return state.accounts;
      case 'acquire': return acquire();
      case 'release': return release();
      case 'renew': if (state.leases[request.lease]) state.leases[request.lease].expires = now + 120000; return;
      default: throw new Error('Invalid Go broker action');
    }
  }
  let result;
  try { result = dispatch(); }
  catch (error) { result = { brokerError: error.message }; process.exitCode = 1; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, path);
  } finally { await fs.rm(temporary, { force: true }); }
  process.stdout.write(JSON.stringify(result ?? null));
}

export async function brokerState(path, request) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '--wait', '10', `${path}.lock`, process.execPath, workerPath, '--broker-transaction', path], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('OpenCode Go broker state timed out')); }, 15000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('OpenCode Go broker requires flock on this host')); });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (code !== 0) reject(new Error(result.brokerError || 'OpenCode Go broker state failed'));
        else resolve(result);
      } catch { reject(new Error('Could not access OpenCode Go broker state. Check host flock support and file permissions.')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

if (process.argv[1] === workerPath && process.argv[2] === '--broker-transaction') {
  void transaction().catch(error => {
    process.stdout.write(JSON.stringify({ brokerError: error.message }));
    process.exitCode = 1;
  });
}
