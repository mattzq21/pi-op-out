import fs from 'node:fs';
import path from 'node:path';
import { TYPE } from './mirror.mjs';

function settleReport(marks, geometry) {
  const report = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].t, end = marks[i + 1]?.t ?? Infinity;
    const samples = geometry.filter(g => g.t > start && g.t <= end);
    const bySelector = {};
    for (const g of samples) {
      const entry = bySelector[g.selector] ||= { changes: 0, lastChangeMs: null, final: null };
      entry.changes++;
      entry.lastChangeMs = g.t - start;
      entry.final = g.present ? { width: g.width, height: g.height, scrollTop: g.scrollTop, gapToBottom: g.gapToBottom } : { present: false };
    }
    report.push({ mark: marks[i].label, offsetMs: marks[i].t - marks[0].t, selectors: bySelector });
  }
  return report;
}

export function writeRecording(outDir, result, track = []) {
  fs.mkdirSync(outDir, { recursive: true });
  const eventsFile = path.join(outDir, 'events.json');
  fs.writeFileSync(eventsFile, JSON.stringify(result.events));
  fs.writeFileSync(path.join(outDir, 'geometry.json'), JSON.stringify(result.geometry, null, 1));
  const events = result.events;
  const counts = {};
  for (const e of events) counts[TYPE[e.type]] = (counts[TYPE[e.type]] || 0) + 1;
  const meta = {
    eventsFile, events: events.length, counts, durationMs: events.length ? events.at(-1).timestamp - events[0].timestamp : 0,
    marks: result.marks.map(m => ({ label: m.label, offsetMs: events.length ? m.t - events[0].timestamp : null })),
    geometrySamples: result.geometry.length, samplerTicks: result.ticks, visibilityState: result.visibilityState, viewport: result.viewport, href: result.href,
    settle: settleReport(result.marks, result.geometry),
  };
  fs.writeFileSync(path.join(outDir, 'recording.json'), JSON.stringify(meta, null, 1));
  const summary = { eventsFile, events: events.length, durationMs: meta.durationMs, marks: meta.marks.length, geometrySamples: result.geometry.length };
  if (result.ticks === 0 && result.geometry.length === 0 && track.length) summary.warning = 'sampler never ran';
  const neverPresent = track.filter(sel => !result.geometry.some(g => g.selector === sel && g.present));
  if (neverPresent.length) summary.warning = (summary.warning ? summary.warning + '; ' : '') + 'tracked selectors never matched: ' + neverPresent.join(', ');
  for (const s of meta.settle) for (const [sel, e] of Object.entries(s.selectors)) (summary.settle ||= []).push(`${s.mark} ${sel}: ${e.changes} changes, last ${e.lastChangeMs} ms`);
  return summary;
}
