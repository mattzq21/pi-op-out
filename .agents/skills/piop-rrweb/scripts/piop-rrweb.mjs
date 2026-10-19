#!/usr/bin/env node
// Record, replay and read rrweb recordings of the Piop WebView. Run with --help for commands.
import fs from 'node:fs';
import path from 'node:path';
import { openSession, chordActions } from './lib/webdriver.mjs';
import { ensureBundles } from './lib/bundles.mjs';
import { Mirror, loadEvents, markers, resolveTime, isMutation, isCustom, TYPE, SOURCE } from './lib/mirror.mjs';
import * as PAGE from './lib/page.mjs';
import { buildViewer, verifyViewer } from './lib/replay.mjs';

const HELP = `piop-rrweb.mjs <command> [options]

Recording (needs --session <session.json> printed by piop-wdio's tauri-webdriver.py):
  start   [--track "sel1,sel2"] [--mask] [--interval 20]   inject rrweb, start recording and geometry sampling
  mark    <label>                                          add a time marker
  click   <selector> [--label L]                           mark + element.click() in one call
  type    <selector> <text> [--label L]                    mark + WebDriver key input into the element
  keys    "<chords>" [--label L]                           mark + WebDriver key actions, e.g. "Ctrl+B" or "ArrowLeft ArrowLeft"
  drag    <selector> --dx N [--dy N] [--steps 10] [--label L]  mark + synthetic pointer drag
  js      "<script body>" | --file F                       run a script body (may use return) in the WebView
  status                                                   recorder state
  stop    --out DIR                                        stop, write events.json, geometry.json, recording.json
  record  --out DIR --steps steps.json [start options]     start, run steps, stop. steps.json is a list of
          {"mark":L} {"click":sel} {"click":{"text":"Local","within":".settings-nav"}} {"type":[sel,text]} {"keys":chords}
          {"drag":sel,"dx":N} {"js":code} {"wait":ms}; add "label":L to name the marker

Replay (headless Chromium, no session needed):
  replay  <events.json|DIR> [--out DIR] [--at 1.5,3.2] [--after 300] [--selector "sel1,sel2"] [--speed 4]
          builds replay.html, seeks to each marker (+after ms) and --at time, screenshots, plays to the end, writes verify.json

Reading events (no browser):
  summary <events.json>                                    counts, mutations per second, markers
  diff    <events.json> --between A B | --from T --to T    DOM changes between two markers or times (seconds), node ids resolved to paths
  quiet   <events.json> [--after LABEL] [--ms 2000]        last DOM change after each marker; fails when one lands later than --ms
  find    <events.json> <query> [--at T]                   nodes whose tag/attributes/text contain query
  attrs   <events.json> [--id N] [--name style] [--all]    attribute change timeline (repeats hidden unless --all)
  texts   <events.json>                                    text and input changes
  dom     <events.json> [--at T] [--id N] [--depth D]      DOM outline at time T (seconds; default end)
  fetch                                                    download the rrweb bundles into the cache

Marker names: a label, label#2 for the second with that label, or a number of seconds.
`;

const argv = process.argv.slice(2);
process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); throw error; });
const command = argv.shift();
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    if (['mask', 'all', 'json', 'help'].includes(name)) flags[name] = true;
    else flags[name] = argv[++i];
  } else positional.push(a);
}
if (!command || command === '--help' || flags.help) { process.stdout.write(HELP); process.exit(command ? 0 : 2); }

const out = value => process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
const fail = message => { process.stderr.write('piop-rrweb: ' + message + '\n'); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);

function session() {
  const file = flags.session || process.env.PIOP_WDIO_SESSION;
  if (!file) fail('--session <session.json> is required (or set PIOP_WDIO_SESSION)');
  return openSession(file);
}

async function checkResult(value) {
  if (value && value.error) fail(value.error);
  return value;
}

async function doStart(wd) {
  const bundles = ensureBundles();
  const loaded = await wd.execute('return typeof rrwebRecord !== "undefined"');
  if (!loaded) {
    const source = fs.readFileSync(bundles.record, 'utf8');
    await wd.execute(source + '\n;return typeof rrwebRecord;');
  }
  const options = { mask: !!flags.mask, track: list(flags.track), intervalMs: Number(flags.interval || 20) };
  const info = await checkResult(await wd.execute(PAGE.START, [options]));
  if (info.visibilityState === 'hidden') info.note = 'visibilityState is hidden: requestAnimationFrame does not run; sampling uses timers and observers';
  const missing = info.tracked.filter(t => !t.present).map(t => t.selector);
  if (missing.length) info.warning = 'tracked selectors not present yet: ' + missing.join(', ');
  return info;
}

async function doStep(wd, step) {
  if ('mark' in step) return checkResult(await wd.execute(PAGE.MARK, [step.mark, step.payload || {}]));
  if ('click' in step) return checkResult(await wd.execute(PAGE.CLICK, [step.label || 'click:' + (typeof step.click === 'string' ? step.click : step.click.text), step.click]));
  if ('type' in step) {
    const [selector, text] = step.type;
    await wd.execute(PAGE.MARK, [step.label || 'type:' + selector, { selector, length: text.length }]);
    await wd.sendKeys(selector, text);
    await wd.execute(PAGE.MARK, [(step.label || 'type:' + selector) + ':done', { selector }]);
    return { typed: text.length, into: selector };
  }
  if ('keys' in step) {
    await wd.execute(PAGE.MARK, [step.label || 'keys:' + step.keys, { keys: step.keys }]);
    await wd.keyActions(chordActions(step.keys));
    return { keys: step.keys };
  }
  if ('drag' in step) {
    const steps = Number(step.steps || 10);
    const label = step.label || 'drag:' + step.drag;
    return checkResult(await wd.executeAsync(PAGE.DRAG, [label, step.drag, Number(step.dx || 0), Number(step.dy || 0), steps, Number(step.interval || 30)]));
  }
  if ('js' in step) {
    if (step.label) await wd.execute(PAGE.MARK, [step.label, {}]);
    return wd.execute(step.js, step.args || []);
  }
  if ('wait' in step) { await sleep(Number(step.wait)); return { waited: Number(step.wait) }; }
  fail('unknown step ' + JSON.stringify(step));
}

// Per mark and tracked selector: when did the geometry last change before the next mark?
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

async function doStop(wd, outDir) {
  const result = await checkResult(await wd.execute(PAGE.STOP));
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
  if (result.ticks === 0 && result.geometry.length === 0 && list(flags.track).length) summary.warning = 'sampler never ran';
  const neverPresent = list(flags.track).filter(sel => !result.geometry.some(g => g.selector === sel && g.present));
  if (neverPresent.length) summary.warning = (summary.warning ? summary.warning + '; ' : '') + 'tracked selectors never matched: ' + neverPresent.join(', ');
  for (const s of meta.settle) for (const [sel, e] of Object.entries(s.selectors)) (summary.settle ||= []).push(`${s.mark} ${sel}: ${e.changes} changes, last ${e.lastChangeMs} ms`);
  return summary;
}

async function runReplay() {
  const target = positional[0] || fail('events.json or DIR required');
  const eventsFile = fs.statSync(target).isDirectory() ? path.join(target, 'events.json') : target;
  const events = loadEvents(eventsFile);
  const outDir = flags.out || path.dirname(eventsFile);
  const { file } = buildViewer(events, outDir);
  const after = Number(flags.after ?? 300);
  const durationMs = events.at(-1).timestamp - events[0].timestamp;
  const points = markers(events).filter(m => m.tag === 'mark').map(m => ({ label: m.payload?.label ?? 'mark', offsetMs: Math.min(durationMs, m.offsetMs + after), clamped: m.offsetMs + after > durationMs }));
  for (const sec of list(flags.at)) points.push({ label: 't' + sec, offsetMs: Number(sec) * 1000 });
  if (!points.length) points.push({ label: 'end', offsetMs: durationMs });
  const result = await verifyViewer(file, { points, selectors: list(flags.selector), speed: Number(flags.speed || 4), durationMs });
  fs.writeFileSync(path.join(outDir, 'verify.json'), JSON.stringify(result, null, 1));
  const brief = { ok: result.ok, viewer: file, verify: path.join(outDir, 'verify.json'), finished: result.finished, playbackWallMs: result.playbackWallMs,
    pageErrors: result.pageErrors.length, consoleIssues: result.console.length, failedRequests: result.failedRequests, selectorsNeverPresent: result.selectorsNeverPresent,
    points: result.points.map(p => ({ label: p.label, offsetMs: p.offsetMs, clamped: p.clamped, nodes: p.nodes, screenshot: p.screenshot, selectors: p.selectors })) };
  out(flags.json ? brief : JSON.stringify(brief, null, 1));
  if (!result.ok) process.exit(1);
}

const rel = (events, t) => ((t - events[0].timestamp) / 1000).toFixed(3) + 's';
const show = (v, max = 80) => (v == null ? 'null' : JSON.stringify(String(v).slice(0, max)));

function runSummary(events) {
  const byType = {}, bySource = {}, perSecond = {};
  for (const e of events) {
    byType[TYPE[e.type]] = (byType[TYPE[e.type]] || 0) + 1;
    if (e.type !== 3) continue;
    const s = SOURCE[e.data.source] ?? e.data.source;
    bySource[s] = (bySource[s] || 0) + 1;
    if (e.data.source !== 0) continue;
    const k = Math.floor((e.timestamp - events[0].timestamp) / 1000);
    const b = perSecond[k] ||= { events: 0, adds: 0, removes: 0, texts: 0, attrs: 0 };
    b.events++; b.adds += e.data.adds.length; b.removes += e.data.removes.length; b.texts += e.data.texts.length; b.attrs += e.data.attributes.length;
  }
  const meta = events.find(e => e.type === 4);
  out(`events: ${events.length}  duration: ${rel(events, events.at(-1).timestamp)}${meta ? `  viewport: ${meta.data.width}x${meta.data.height}  ${meta.data.href}` : ''}`);
  out('by type: ' + JSON.stringify(byType));
  out('incremental by source: ' + JSON.stringify(bySource));
  out('mutations per second (sec: events  adds/removes/texts/attrs):');
  for (const [k, b] of Object.entries(perSecond)) out(`  ${k.padStart(3)}s: ${String(b.events).padStart(4)}  ${b.adds}/${b.removes}/${b.texts}/${b.attrs}`);
  const marks = markers(events);
  const geometry = marks.filter(m => m.tag === 'geometry').length;
  out(`markers: ${marks.length - geometry}${geometry ? ` (+${geometry} geometry samples)` : ''}`);
  for (const m of marks) if (m.tag !== 'geometry') out(`  ${(m.offsetMs / 1000).toFixed(3)}s  ${m.payload?.label ?? m.tag}${m.payload?.selector ? '  ' + m.payload.selector : ''}`);
}

function runDiff(events) {
  let from, to;
  if (flags.between) { from = resolveTime(events, flags.between); to = resolveTime(events, positional[1] || fail('--between A B needs two markers')); }
  else if (flags.from != null) { from = resolveTime(events, flags.from); to = flags.to != null ? resolveTime(events, flags.to) : Infinity; }
  else fail('give --between A B or --from T [--to T]');
  if (to < from) [from, to] = [to, from];
  const mirror = new Mirror();
  const totals = { mutations: 0, adds: 0, removes: 0, texts: 0, attrs: 0, attrsUnchanged: 0, addedNodes: 0, removedNodes: 0, placeholderSwaps: 0 };
  const lines = [];
  mirror.replay(events, to, (e, changes) => {
    if (!changes || e.timestamp < from) return;
    totals.mutations++;
    const shown = changes.filter(c => flags.all || c.changed !== false);
    const removedPlaceholders = changes.filter(c => c.kind === 'remove' && c.placeholder).length;
    const addedPlaceholders = changes.filter(c => c.kind === 'add' && c.placeholder).length;
    totals.placeholderSwaps += Math.min(removedPlaceholders, addedPlaceholders);
    for (const c of changes) {
      if (c.kind === 'add') { totals.adds++; totals.addedNodes += c.size; }
      if (c.kind === 'remove') { totals.removes++; totals.removedNodes += c.size; }
      if (c.kind === 'text') totals.texts++;
      if (c.kind === 'attr') { totals.attrs++; if (!c.changed) totals.attrsUnchanged++; }
    }
    if (!shown.length) return;
    lines.push(`== +${e.timestamp - from} ms (${rel(events, e.timestamp)})`);
    for (const c of shown) {
      if (c.kind === 'add') lines.push(`  ADD    ${c.label} (${c.size} nodes)${c.placeholder ? ' [placeholder]' : ''} into ${c.path}`);
      else if (c.kind === 'remove') lines.push(`  REMOVE ${c.label} (${c.size} nodes)${c.placeholder ? ' [placeholder]' : ''} from ${c.path}`);
      else if (c.kind === 'text') lines.push(`  TEXT   ${c.path}: ${show(c.before, 60)} -> ${show(c.after, 60)}`);
      else lines.push(`  ATTR   ${c.path} ${c.name}: ${show(c.before)} -> ${show(c.after)}${c.changed ? '' : ' (unchanged)'}`);
    }
  });
  if (flags.json) return out({ fromMs: from - events[0].timestamp, toMs: to - events[0].timestamp, totals, lines });
  out(`window: ${rel(events, from)} -> ${Number.isFinite(to) ? rel(events, to) : 'end'}`);
  const max = Number(flags.limit || 400);
  for (const l of lines.slice(0, max)) out(l);
  if (lines.length > max) out(`... ${lines.length - max} more lines (use --limit)`);
  out(`totals: ${totals.mutations} mutation events, +${totals.addedNodes} nodes in ${totals.adds} adds, -${totals.removedNodes} nodes in ${totals.removes} removes, ${totals.texts} texts, ${totals.attrs} attrs (${totals.attrsUnchanged} unchanged values hidden), ${totals.placeholderSwaps} placeholder swaps`);
}

function runAttrs(events) {
  const wantId = flags.id != null ? Number(flags.id) : null, name = flags.name;
  let raw = 0, shown = 0;
  const mirror = new Mirror();
  mirror.replay(events, null, (e, changes) => {
    if (!changes) return;
    for (const c of changes) {
      if (c.kind !== 'attr' || (wantId != null && c.id !== wantId) || (name && c.name !== name)) continue;
      raw++;
      if (!flags.all && !c.changed) continue;
      shown++;
      out(`${rel(events, e.timestamp)}  ${c.label} (id ${c.id})  ${c.name}=${show(c.after, 100)}${c.changed ? '' : ' (unchanged)'}`);
    }
  });
  out(`-- ${shown} shown of ${raw} attribute records`);
}

function runTexts(events) {
  const mirror = new Mirror();
  mirror.replay(events, null, (e, changes) => {
    if (e.type === 3 && e.data.source === 5) {
      const masked = e.data.text && /^\*+$/.test(e.data.text);
      out(`${rel(events, e.timestamp)}  input  ${mirror.label(e.data.id)} = ${JSON.stringify(e.data.text)}${masked ? ' (masked)' : ''}`);
    }
    if (!changes) return;
    for (const c of changes) {
      if (c.kind === 'text' && c.changed) out(`${rel(events, e.timestamp)}  text   ${c.path} = ${JSON.stringify(String(c.after).slice(0, 120))}`);
      if (c.kind === 'add' && c.label.startsWith('#text"')) out(`${rel(events, e.timestamp)}  added  ${c.label} under ${c.path}`);
    }
  });
}

function mirrorAt(events) {
  const mirror = new Mirror();
  mirror.replay(events, flags.at != null ? resolveTime(events, flags.at) : null);
  return mirror;
}

async function main() {
  switch (command) {
    case 'fetch': return out(ensureBundles());
    case 'start': return out(await doStart(session()));
    case 'status': return out(await session().execute(PAGE.STATUS));
    case 'mark': return out(await doStep(session(), { mark: positional[0] || fail('label required'), payload: flags.payload ? JSON.parse(flags.payload) : {} }));
    case 'click': return out(await doStep(session(), { click: positional[0] || fail('selector required'), label: flags.label }));
    case 'type': return out(await doStep(session(), { type: [positional[0] || fail('selector required'), positional[1] ?? ''], label: flags.label }));
    case 'keys': return out(await doStep(session(), { keys: positional[0] || fail('key chords required'), label: flags.label }));
    case 'drag': return out(await doStep(session(), { drag: positional[0] || fail('selector required'), dx: flags.dx, dy: flags.dy, steps: flags.steps, interval: flags.interval, label: flags.label }));
    case 'js': {
      const code = flags.file ? fs.readFileSync(flags.file, 'utf8') : positional[0] || fail('script body required');
      const value = await session().execute(code, flags.args ? JSON.parse(flags.args) : []);
      return out(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
    }
    case 'stop': return out(await doStop(session(), flags.out || fail('--out DIR required')));
    case 'record': {
      const outDir = flags.out || fail('--out DIR required');
      const steps = JSON.parse(fs.readFileSync(flags.steps || fail('--steps steps.json required'), 'utf8'));
      const wd = session();
      const info = await doStart(wd);
      const log = [{ start: info }];
      await sleep(Number(flags.lead || 500));
      for (const step of steps) {
        try { log.push({ step, result: await doStep(wd, step) }); }
        catch (error) { log.push({ step, error: String(error.message) }); break; }
      }
      await sleep(Number(flags.settle || 1500));
      const summary = await doStop(wd, outDir);
      fs.writeFileSync(path.join(outDir, 'steps.log.json'), JSON.stringify(log, null, 1));
      const failed = log.find(l => l.error);
      if (failed) summary.failedStep = failed;
      return out(summary);
    }
    case 'replay': return runReplay();
    case 'summary': return runSummary(loadEvents(positional[0] || fail('events.json required')));
    case 'diff': return runDiff(loadEvents(positional[0] || fail('events.json required')));
    case 'quiet': return runQuiet(loadEvents(positional[0] || fail('events.json required')));
    case 'attrs': return runAttrs(loadEvents(positional[0] || fail('events.json required')));
    case 'texts': return runTexts(loadEvents(positional[0] || fail('events.json required')));
    case 'find': {
      const events = loadEvents(positional[0] || fail('events.json required'));
      const mirror = mirrorAt(events);
      for (const m of mirror.find(positional[1] || fail('query required')).slice(0, Number(flags.limit || 50))) out(`${mirror.label(m.id)} (id ${m.id})  ${mirror.path(m.id)}`);
      return;
    }
    case 'dom': {
      const events = loadEvents(positional[0] || fail('events.json required'));
      const mirror = mirrorAt(events);
      const root = flags.id != null ? Number(flags.id) : mirror.root();
      for (const line of mirror.outline(root, { depth: Number(flags.depth || 40), maxLines: Number(flags.limit || 1500) })) out(line);
      return;
    }
    default: fail('unknown command ' + command + '\n' + HELP);
  }
}

main().catch(error => fail(error.stack || String(error)));
function runQuiet(events) {
  const limit = Number(flags.ms || 2000);
  const marks = markers(events).filter(m => m.tag === 'mark' && (!flags.after || (m.payload?.label ?? m.tag) === flags.after));
  if (!marks.length) fail('no matching markers');
  const t0 = events[0].timestamp;
  let failed = false;
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].timestamp;
    const next = markers(events).filter(m => m.tag === 'mark').find(m => m.timestamp > start)?.timestamp ?? Infinity;
    const inWindow = events.filter(e => isMutation(e) && e.timestamp > start && e.timestamp <= next);
    const late = inWindow.filter(e => e.timestamp - start > limit);
    const last = inWindow.at(-1);
    const watched = Math.min(next, events.at(-1).timestamp) - start;
    if (late.length) failed = true;
    out(`${((start - t0) / 1000).toFixed(3)}s ${marks[i].payload?.label ?? marks[i].tag}: ${inWindow.length} mutation events in the next ${watched} ms, last at +${last ? last.timestamp - start : '-'} ms${late.length ? `, ${late.length} after ${limit} ms` : ''}${watched < limit ? ' (window shorter than --ms)' : ''}`);
  }
  if (failed) process.exit(1);
}

