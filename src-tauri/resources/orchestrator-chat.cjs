const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = process.argv[1];
const id = '00000000-0000-4000-8000-000000000001';
const cwd = path.join(root, 'orchestrator');
const sessions = path.join(root, 'sessions');
const sessionPath = path.join(sessions, `orchestrator_${id}.jsonl`);
fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
if (!fs.existsSync(sessionPath)) {
  const timestamp = new Date().toISOString();
  const temporary = `${sessionPath}.${randomUUID()}.tmp`;
  const entries = [
    { type: 'session', version: 3, id, timestamp, cwd },
    { type: 'session_info', id: 'orchestrator-name', parentId: null, timestamp, name: 'Orchestrator' },
    { type: 'custom', id: 'orchestrator-agent', parentId: 'orchestrator-name', timestamp, customType: 'pi-define-agents-state', data: { active: 'voice-orchestrator' } },
  ];
  try {
    fs.writeFileSync(temporary, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, sessionPath); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { fs.rmSync(temporary, { force: true }); }
}
process.stdout.write(JSON.stringify({ id, path: sessionPath, cwd, name: 'Orchestrator', project: '', hostId: 'local', hostName: 'Local', cwdExists: true, messageCount: 0, lastMessageAt: 0, apiCost: 0, preview: '' }));
