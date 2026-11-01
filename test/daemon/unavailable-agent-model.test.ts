import { test, expect } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startDaemon } from './harness';

test('an unavailable agent model does not prevent startup and clears after repair', async () => {
  const initial = await startDaemon();
  await initial.stop();
  const file = join(initial.home, '.piop/sessions.sqlite');
  const update = (repair: boolean) => {
    const db = new DatabaseSync(file);
    try {
      const row: any = db.prepare("SELECT body FROM application_settings WHERE name='agent-definitions.json'").get();
      const config = JSON.parse(Buffer.from(row.body).toString());
      if (!repair) {
        const general = config.agents.find((agent: any) => agent.name === 'general');
        config.agents.push({ ...general, name: 'missing-model', isDefault: false, model: 'missing-provider/missing-model' });
      } else config.agents.find((agent: any) => agent.name === 'missing-model').model = '';
      db.prepare("UPDATE application_settings SET body=? WHERE name='agent-definitions.json'").run(Buffer.from(JSON.stringify(config)));
    } finally { db.close(); }
  };
  update(false);
  const daemon = await startDaemon({ home: initial.home });
  try {
    const catalog = await daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', reload: true } });
    expect(catalog.config.agents.find((agent: any) => agent.name === 'missing-model').unavailableReason).toContain('missing-provider/missing-model');
    expect(catalog.config.agents.find((agent: any) => agent.name === 'general').unavailableReason).toBeUndefined();
    update(true);
    const repaired = await daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', reload: true } });
    expect(repaired.config.agents.find((agent: any) => agent.name === 'missing-model').unavailableReason).toBeUndefined();
  } finally { await daemon.stop(); }
}, 60_000);
