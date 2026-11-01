import { Mirror, isMutation } from './mirror.mjs';

const clip = (v, max = 40) => (v == null ? 'null' : JSON.stringify(String(v).replace(/\s+/g, ' ').trim().slice(0, max)));

function signature(mirror, id) {
  const m = mirror.nodes.get(id);
  if (!m) return '';
  if (m.type === 3) return (m.text || '').trim() ? JSON.stringify((m.text || '').replace(/\s+/g, ' ').trim()) : '';
  if (m.type !== 2) return '';
  return m.tag + (m.attrs.class ? '.' + String(m.attrs.class).trim().split(/\s+/).sort().join('.') : '') + '[' + m.children.map(c => signature(mirror, c)).filter(Boolean).join(',') + ']';
}

function textOf(mirror, id) {
  const m = mirror.nodes.get(id);
  if (!m) return '';
  if (m.type === 3) return m.text || '';
  return m.children.map(c => textOf(mirror, c)).join(' ');
}

const norm = s => s.replace(/\[aria-label="[^"]*\d[^"]*"\]/g, '[aria-label=*]');

const blank = (mirror, id) => {
  const m = mirror.nodes.get(id);
  return !m || (m.type === 3 && !(m.text || '').trim()) || m.type === 5;
};

export function refreshReport(events, from, to, { flipMs = 1000, limit = 60 } = {}) {
  const mirror = new Mirror();
  const removed = [], added = [], values = new Map(), rewrites = new Map();
  let placeholders = 0;
  for (const e of events) {
    if (e.timestamp > to) break;
    if (e.type === 2) { mirror.nodes.clear(); mirror.addSerialized(e.data.node, null); continue; }
    if (!isMutation(e)) continue;
    if (e.timestamp < from) { mirror.applyMutation(e.data); continue; }
    const t = e.timestamp - from;
    for (const r of e.data.removes || []) {
      if (blank(mirror, r.id)) { placeholders++; continue; }
      removed.push({ id: r.id, parent: r.parentId, t, sig: signature(mirror, r.id), label: mirror.label(r.id), path: mirror.path(r.parentId), size: mirror.size(r.id), text: textOf(mirror, r.id) });
    }
    const changes = mirror.applyMutation(e.data);
    const addedIds = new Set((e.data.adds || []).map(a => a.node.id));
    for (const a of e.data.adds || []) {
      if (addedIds.has(a.parentId)) continue;
      if (blank(mirror, a.node.id)) { placeholders++; continue; }
      added.push({ id: a.node.id, parent: a.parentId, t, sig: signature(mirror, a.node.id), label: mirror.label(a.node.id), path: mirror.path(a.parentId), size: mirror.size(a.node.id) });
    }
    for (const c of changes) {
      if (c.kind !== 'attr' && c.kind !== 'text') continue;
      const name = c.kind === 'text' ? '#text' : c.name;
      const where = c.path;
      if (!c.changed) {
        const key = norm(where) + ' ' + name;
        const g = rewrites.get(key) || { where, name, count: 0, ids: new Set(), id: c.id };
        g.count++; g.ids.add(c.id); rewrites.set(key, g);
        continue;
      }
      const key = c.id + ' ' + name;
      if (!values.has(key)) values.set(key, { id: c.id, name, where, changes: [] });
      values.get(key).changes.push({ t, before: c.before, after: c.after });
    }
  }

  const groups = new Map();
  const used = new Set();
  for (const r of removed) {
    let match = -1;
    for (const same of [a => a.id === r.id, a => a.parent === r.parent, () => true]) {
      match = added.findIndex((a, i) => !used.has(i) && a.sig === r.sig && same(a));
      if (match >= 0) break;
    }
    if (match < 0) continue;
    used.add(match);
    const a = added[match];
    const kind = a.id === r.id ? 'MOVE' : 'RECREATE';
    const from = norm(r.path), to = norm(a.path);
    const key = kind + ' ' + norm(r.label) + ' ' + from + ' ' + to;
    const g = groups.get(key) || { kind, label: norm(r.label), from, to, count: 0, parents: new Set(), size: r.size, first: Math.min(r.t, a.t), text: r.text, id: a.id };
    g.count++; g.parents.add(r.parent); groups.set(key, g);
  }

  const flips = new Map();
  for (const v of values.values()) {
    const c = v.changes;
    for (let i = 0; i < c.length; i++) {
      const j = c.findIndex((x, k) => k > i && x.after === c[i].before && x.t - c[i].t <= flipMs);
      if (j < 0) continue;
      const key = norm(v.where) + ' ' + v.name + ' ' + c[i].before + ' ' + c[i].after;
      const g = flips.get(key) || { where: norm(v.where), name: v.name, before: c[i].before, during: c[i].after, count: 0, ids: new Set(), maxMs: 0, first: c[i].t, id: v.id };
      g.count++; g.ids.add(v.id); g.maxMs = Math.max(g.maxMs, c[j].t - c[i].t); flips.set(key, g);
      i = j;
    }
  }

  const lines = [];
  const take = (list, format) => {
    list.sort((a, b) => b.count - a.count);
    for (const g of list.slice(0, limit)) lines.push(format(g));
    if (list.length > limit) lines.push(`... ${list.length - limit} more (use --limit)`);
  };
  const recreated = [...groups.values()];
  take(recreated, g => `${g.kind} ${g.count}x in ${g.parents.size} parents  ${g.label} (${g.size} nodes, id ${g.id})  in ${g.from}${g.to !== g.from ? '  -> ' + g.to : ''}${g.text.trim() ? '  text ' + clip(g.text) : ''}  first +${g.first} ms`);
  take([...flips.values()], g => `FLIP ${g.count}x on ${g.ids.size} nodes (id ${g.id})  ${g.where}  ${g.name}: ${clip(g.before)} -> ${clip(g.during)} -> back  max ${g.maxMs} ms  first +${g.first} ms`);
  take([...rewrites.values()], g => `REWRITE ${g.count}x on ${g.ids.size} nodes (id ${g.id})  ${g.where}  ${g.name} (same value)`);
  const sum = (list, kind) => list.filter(g => !kind || g.kind === kind).reduce((s, g) => s + g.count, 0);
  return { lines, totals: { recreate: sum(recreated, 'RECREATE'), move: sum(recreated, 'MOVE'), flip: sum([...flips.values()]), rewrite: sum([...rewrites.values()]), placeholders } };
}
