import fs from 'node:fs';

export const TYPE = ['DomContentLoaded', 'Load', 'FullSnapshot', 'Incremental', 'Meta', 'Custom', 'Plugin'];
export const SOURCE = ['Mutation', 'MouseMove', 'MouseInteraction', 'Scroll', 'ViewportResize', 'Input', 'TouchMove', 'MediaInteraction', 'StyleSheetRule', 'CanvasMutation', 'Font', 'Log', 'Drag', 'StyleDeclaration', 'Selection', 'AdoptedStyleSheet', 'CustomElement'];
const NODE_TYPE = ['document', 'doctype', 'element', 'text', 'cdata', 'comment'];

export function loadEvents(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = Array.isArray(parsed) ? parsed : parsed.events;
  if (!Array.isArray(events) || !events.length) throw new Error(`${file}: not an rrweb event array`);
  return events;
}

export const isMutation = e => e.type === 3 && e.data.source === 0;
export const isCustom = e => e.type === 5;

export function markers(events) {
  const t0 = events[0].timestamp;
  return events.filter(isCustom).map(e => ({ tag: e.data.tag, payload: e.data.payload, timestamp: e.timestamp, offsetMs: e.timestamp - t0 }));
}

export function resolveTime(events, spec) {
  const t0 = events[0].timestamp;
  if (/^[+-]?\d+(\.\d+)?s?$/.test(spec)) return t0 + parseFloat(spec) * 1000;
  const m = /^(.*?)(?:#(\d+))?$/.exec(spec);
  const wanted = m[1];
  const index = m[2] ? Number(m[2]) - 1 : 0;
  const found = events.filter(e => isCustom(e) && (e.data.tag === wanted || e.data.payload?.label === wanted));
  if (!found[index]) throw new Error(`No marker "${spec}". Markers: ${[...new Set(markers(events).map(x => x.payload?.label ?? x.tag))].join(', ') || 'none'}`);
  return found[index].timestamp;
}

function styleToString(prev, diff) {
  const decl = new Map();
  for (const part of String(prev || '').split(';')) {
    const [k, ...v] = part.split(':');
    if (k && k.trim()) decl.set(k.trim(), v.join(':').trim());
  }
  for (const [k, v] of Object.entries(diff)) {
    if (v === false) decl.delete(k);
    else decl.set(k, Array.isArray(v) ? v[0] + ' !' + v[1] : v);
  }
  return [...decl].map(([k, v]) => k + ': ' + v).join('; ');
}

export class Mirror {
  constructor() { this.nodes = new Map(); }

  addSerialized(n, parent) {
    const m = { id: n.id, type: n.type, tag: n.tagName, attrs: { ...(n.attributes || {}) }, text: n.textContent, parent, children: [] };
    this.nodes.set(n.id, m);
    for (const c of n.childNodes || []) m.children.push(this.addSerialized(c, n.id).id);
    return m;
  }

  removeNode(id) {
    const m = this.nodes.get(id);
    if (!m) return;
    for (const c of m.children) this.removeNode(c);
    this.nodes.delete(id);
  }

  size(id) {
    const m = this.nodes.get(id);
    return m ? 1 + m.children.reduce((s, c) => s + this.size(c), 0) : 0;
  }

  static serializedSize(n) { return 1 + (n.childNodes || []).reduce((s, c) => s + Mirror.serializedSize(c), 0); }

  applyMutation(d) {
    const out = [];
    for (const r of d.removes || []) {
      const m = this.nodes.get(r.id);
      out.push({ kind: 'remove', id: r.id, label: this.label(r.id), path: this.path(r.parentId), size: this.size(r.id), placeholder: isPlaceholder(m) });
      const p = this.nodes.get(r.parentId);
      if (p) p.children = p.children.filter(c => c !== r.id);
      this.removeNode(r.id);
    }
    for (const a of d.adds || []) {
      const old = this.nodes.get(a.node.id);
      const oldParent = old && this.nodes.get(old.parent);
      if (oldParent) oldParent.children = oldParent.children.filter(c => c !== a.node.id);
      const p = this.nodes.get(a.parentId);
      const m = this.addSerialized(a.node, a.parentId);
      if (p) {
        const i = a.nextId != null ? p.children.indexOf(a.nextId) : -1;
        if (i >= 0) p.children.splice(i, 0, m.id); else p.children.push(m.id);
      }
      out.push({ kind: 'add', id: m.id, label: this.label(m.id), path: this.path(a.parentId), size: Mirror.serializedSize(a.node), placeholder: isPlaceholder(m) });
    }
    for (const t of d.texts || []) {
      const m = this.nodes.get(t.id);
      out.push({ kind: 'text', id: t.id, path: this.path(m?.parent), before: m?.text, after: t.value, changed: m?.text !== t.value });
      if (m) m.text = t.value;
    }
    for (const a of d.attributes || []) {
      const m = this.nodes.get(a.id);
      if (!m) continue;
      for (const [k, v] of Object.entries(a.attributes)) {
        const before = m.attrs[k] ?? null;
        let after;
        if (v === null) after = null;
        else if (typeof v === 'object') after = styleToString(m.attrs[k], v);
        else after = v;
        out.push({ kind: 'attr', id: a.id, label: this.label(a.id), path: this.path(a.id), name: k, before, after, changed: before !== after });
        if (after === null) delete m.attrs[k]; else m.attrs[k] = after;
      }
    }
    return out;
  }

  replay(events, untilMs = null, onEvent = null) {
    for (const e of events) {
      if (untilMs != null && e.timestamp > untilMs) break;
      let changes = null;
      if (e.type === 2) { this.nodes.clear(); this.addSerialized(e.data.node, null); }
      else if (isMutation(e)) changes = this.applyMutation(e.data);
      else if (e.type === 3 && e.data.source === 5) { const m = this.nodes.get(e.data.id); if (m) m.attrs.value = e.data.text; }
      onEvent?.(e, changes);
    }
    return this;
  }

  label(id) {
    const m = this.nodes.get(id);
    if (!m) return '#' + id + '(gone)';
    if (m.type === 3) return '#text' + (m.text?.trim() ? JSON.stringify(m.text.trim().slice(0, 30)) : '(blank)');
    if (m.type !== 2) return NODE_TYPE[m.type] ?? 'node';
    const a = m.attrs;
    let s = m.tag;
    if (a.id) s += '#' + a.id;
    if (a.class) s += '.' + String(a.class).trim().split(/\s+/).slice(0, 3).join('.');
    if (a['aria-label']) s += `[aria-label="${a['aria-label']}"]`;
    else if (a.role) s += `[role=${a.role}]`;
    return s;
  }

  path(id, depth = 4) {
    const out = [];
    for (let m = this.nodes.get(id); m && m.tag; m = this.nodes.get(m.parent)) out.unshift(this.label(m.id));
    return out.slice(-depth).join(' > ');
  }

  root() { return [...this.nodes.values()].find(m => m.parent === null)?.id; }

  find(query) {
    const q = query.toLowerCase();
    return [...this.nodes.values()].filter(m => m.type === 2 && (m.tag + ' ' + JSON.stringify(m.attrs) + ' ' + (m.text || '')).toLowerCase().includes(q));
  }

  outline(id, { depth = 40, indent = 0, lines = [], maxLines = 2000 } = {}) {
    const m = this.nodes.get(id);
    if (!m || indent > depth || lines.length >= maxLines) return lines;
    if (m.type === 3) {
      const t = (m.text || '').trim();
      if (t && this.nodes.get(m.parent)?.tag !== 'style') lines.push('  '.repeat(indent) + JSON.stringify(t.slice(0, 100)));
      return lines;
    }
    if (m.type !== 2) { for (const c of m.children) this.outline(c, { depth, indent, lines, maxLines }); return lines; }
    if (['style', 'script', 'svg', 'link', 'meta', 'noscript'].includes(m.tag)) return lines;
    const a = Object.entries(m.attrs).filter(([k]) => !k.startsWith('_') && k !== 'd').map(([k, v]) => k + '="' + String(v).slice(0, 60) + '"').join(' ');
    lines.push('  '.repeat(indent) + '<' + m.tag + (a ? ' ' + a : '') + '> [' + id + ']');
    for (const c of m.children) this.outline(c, { depth, indent: indent + 1, lines, maxLines });
    return lines;
  }
}

function isPlaceholder(m) {
  return !!m && ((m.type === 3 && !(m.text || '').trim()) || m.type === 5);
}
