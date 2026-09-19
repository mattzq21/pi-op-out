const fs = require('node:fs');
(async () => {
  for (const path of process.argv.slice(1)) {
    let header, name, first = '', preview = '', count = 0, cost = 0, lastMessageAt = 0, bytes = 0, pending = [];
    const resumes = new Set();
    const text = message => typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '';
    const timestamp = value => { const numeric = Number(value); if (Number.isFinite(numeric) && numeric > 0) return numeric; const parsed = Date.parse(String(value ?? '')); return Number.isFinite(parsed) ? parsed : 0; };
    try {
      for await (const chunk of fs.createReadStream(path)) {
        let start = 0, end;
        while ((end = chunk.indexOf(10, start)) >= 0) {
          pending.push(chunk.subarray(start, end)); const line = Buffer.concat(pending); pending = []; bytes += line.length + 1; start = end + 1;
          let entry; try { entry = JSON.parse(line.toString('utf8')); } catch { continue; }
          if (!header) { if (entry.type !== 'session') throw Error('Invalid session header'); header = entry; continue; }
          if (entry.type === 'custom' && entry.customType === 'pi-desktop-resume' && typeof entry.data?.message === 'string') resumes.add(entry.data.message);
          if (entry.type === 'session_info' && entry.name?.trim()) name = entry.name.trim().slice(0, 2000);
          const voice = entry.type === 'custom' && entry.customType === 'piop-voice' ? entry.data : undefined;
          if (entry.type !== 'message' && !voice) continue;
          const message = voice ? { role: voice.role, content: voice.text } : entry.message || {}, content = text(message).replace(/^\[Voice request [a-f0-9-]{36}; answer concisely\]\n/, '');
          if (message.role === 'user' && resumes.has(content)) continue;
          // Sidebar recency follows prompts, not later assistant/tool activity.
          if (message.role === 'user') lastMessageAt = Math.max(lastMessageAt, timestamp(voice?.startMs ?? message.timestamp ?? entry.timestamp));
          count++; if (content) { if (!first && message.role === 'user') first = content.slice(0, 2000); preview = [...content].slice(0, 100).join(''); }
          const amount = message.usage?.cost?.total; if (message.role === 'assistant' && Number.isFinite(amount) && amount >= 0) cost += amount;
        }
        if (start < chunk.length) pending.push(chunk.subarray(start));
      }
      if (header) console.log(JSON.stringify({ path, id: header.id || '', cwd: header.cwd || 'Unknown project', name: name || first || 'Untitled session', preview, messageCount: count, lastMessageAt, apiCost: cost, explicitlyNamed: !!name, hasUserMessage: !!first, bytes }));
    } catch (error) { console.error(`${path}: ${error.message}`); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
