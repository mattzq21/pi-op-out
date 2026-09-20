import { createSignal, Index } from "solid-js";
import { createDependencyEffect, createRef, cssPixels } from "../lib/solid";

import { ArrowDown, ArrowUp, Search, X } from "lucide-solid";

type Match = { range: Range };
type Box = { left: number; top: number; width: number; height: number; active: boolean };

function findMatches(root: HTMLElement, query: string): Match[] {
  if (!query) return [];
  // Collapse query whitespace the same way document text is collapsed, so
  // pasted newlines/tabs/double-spaces match visibly adjacent words.
  const collapsedQuery = query.replace(/\s+/g, " ");
  const pattern = new RegExp(collapsedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "giu");
  const matches: Match[] = [];
  let block: Element | null = null;
  let text = "";
  let offsets: Array<{ node: Text; start: number; end: number }> = [];
  const flush = () => {
    for (const found of text.matchAll(pattern)) {
      const start = found.index!, end = start + found[0].length;
      const first = offsets[start], last = offsets[end - 1];
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, first.start);
      range.setEnd(last.node, last.end);
      if (range.getClientRects().length) matches.push({ range });
    }
    text = ""; offsets = [];
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const appendNode = (node: Text, collapse: boolean) => {
    for (let i = 0; i < node.data.length; i++) {
      const char = collapse && /[ \t\r\n\f]/.test(node.data[i]) ? " " : node.data[i];
      if (collapse && char === " " && text.endsWith(" ")) { if (offsets[offsets.length - 1].node === node) offsets[offsets.length - 1].end = i + 1; continue; }
      text += char; offsets.push({ node, start: i, end: i + 1 });
    }
  };
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, parent = node.parentElement;
    if (!parent || !node.data || parent.closest('script, style, textarea, input, [hidden], [aria-hidden="true"]')) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === "hidden" || !parent.getClientRects().length) continue;
    const nextBlock = parent.closest("p, pre, li, h1, h2, h3, h4, h5, h6, td, th, summary, button, label, .message-body") ?? parent;
    if (block !== nextBlock) { flush(); block = nextBlock; }
    const collapse = !["pre", "pre-wrap", "break-spaces"].includes(style.whiteSpace);
    appendNode(node, collapse);
  }
  flush();
  return matches;
}

function composerBounds(element: Element) {
  return element.classList.contains("messages") ? element.closest(".chat-shell")?.querySelector(".composer-stack")?.getBoundingClientRect() : undefined;
}

function reveal(range: Range) {
  for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
    const style = getComputedStyle(element), bounds = element.getBoundingClientRect(), target = range.getBoundingClientRect();
    const composer = composerBounds(element);
    const bottom = composer ? Math.min(bounds.bottom, composer.top) : bounds.bottom;
    if (/auto|scroll/.test(style.overflowY) && (target.top < bounds.top || target.bottom > bottom)) {
      element.scrollTop += target.top - bounds.top - (bottom - bounds.top) / 2;
    }
    if (/auto|scroll/.test(style.overflowX) && (target.left < bounds.left || target.right > bounds.right)) {
      element.scrollLeft += target.left - bounds.left - element.clientWidth / 2;
    }
  }
}

function ownsFindShortcut(event: KeyboardEvent, root: HTMLElement | null, bar: HTMLElement | null, active: boolean) {
  const focused = document.activeElement;
  if (focused?.closest(".keybind-input") || (event.target instanceof Element && event.target.closest(".keybind-input"))) return false;
  const focusedBar = focused?.closest(".find-bar");
  const focusedShell = focused?.closest(".chat-shell");
  return focusedBar ? focusedBar === bar : focusedShell ? focusedShell === root : active;
}

function isFindShortcut(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
}

function findShortcutBlocked(event: KeyboardEvent, enabled: boolean) {
  return !enabled || event.isComposing || Boolean(document.querySelector("dialog[open]"));
}

export function FindInPage(componentProps: { selector: string; scopeKey: string; active?: boolean; enabled?: boolean; onActivate?: () => void }) {
  const [open, setOpen] = createSignal(false);
  const [placement, setPlacement] = createSignal<{ top: number; right: number; maxWidth: number }>();
  const bar = createRef<HTMLElement>(null);
  const [query, setQuery] = createSignal("");
  const [matches, setMatches] = createSignal<Match[]>([]);
  const [index, setIndex] = createSignal(0);
  const [boxes, setBoxes] = createSignal<Box[]>([]);
  const input = createRef<HTMLInputElement>(null);
  const previousFocus = createRef<HTMLElement | null>(null);
  const selected = createRef<Match | undefined>(undefined);
  const close = () => {
    setOpen(false);
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
  };
  const move = (direction: number) => {
    if (!matches().length) return;
    const next = (index() + direction + matches().length) % matches().length;
    selected.current = matches()[next]; setIndex(next); reveal(matches()[next].range);
  };

  createDependencyEffect(() => { const capturedOpen = open(); const capturedEnabled0 = componentProps.enabled; const capturedSelector1 = componentProps.selector; const capturedActive2 = componentProps.active;
    const enabled = capturedEnabled0 ?? true;
    const active = capturedActive2 ?? true;
    const onKey = (event: KeyboardEvent) => {
      if (findShortcutBlocked(event, enabled)) return;
      const root = document.querySelector<HTMLElement>(capturedSelector1);
      if (!ownsFindShortcut(event, root, bar.current, active)) return;
      if (isFindShortcut(event)) {
        event.preventDefault(); event.stopImmediatePropagation();

        if (!capturedOpen) previousFocus.current = document.activeElement as HTMLElement;
        setOpen(true);
        requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
      } else if (capturedOpen && event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); close();
      } else if (capturedOpen && event.key === "F3") {
        event.preventDefault(); event.stopImmediatePropagation(); move(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, () => [open(), close, move, componentProps.selector, (componentProps.active === undefined ? true : componentProps.active), (componentProps.enabled === undefined ? true : componentProps.enabled)]);

  createDependencyEffect(() => { const capturedOpen = open(); const capturedQuery = query(); const capturedEnabled0 = componentProps.enabled; const capturedSelector1 = componentProps.selector;
    if (!capturedOpen || !(capturedEnabled0 === undefined ? true : capturedEnabled0)) { setMatches([]); setBoxes([]); return; }
    const root = document.querySelector<HTMLElement>(capturedSelector1);
    if (!root) { setMatches([]); setBoxes([]); return; }
    let timer = 0;
    const scan = (keepCurrent: boolean) => {
      const next = findMatches(root, capturedQuery), old = keepCurrent ? selected.current?.range : undefined;
      const found = old ? next.findIndex(item => item.range.startContainer === old.startContainer && item.range.startOffset === old.startOffset) : -1;
      const active = Math.max(0, found);
      selected.current = next[active]; setMatches(next); setIndex(active);
      if (!keepCurrent && next[active]) reveal(next[active].range);
    };
    scan(false);
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer); timer = window.setTimeout(() => scan(true), 100);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["open", "hidden", "class", "style"] });
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, () => [open(), query(), componentProps.selector, componentProps.scopeKey, (componentProps.enabled === undefined ? true : componentProps.enabled)]);

  createDependencyEffect(() => { const capturedOpen = open(); const capturedMatches = matches(); const capturedIndex = index(); const capturedEnabled0 = componentProps.enabled; const capturedSelector1 = componentProps.selector;
    if (!capturedOpen || !(capturedEnabled0 === undefined ? true : capturedEnabled0)) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const bounds = document.querySelector(capturedSelector1)?.getBoundingClientRect();
      if (bounds) setPlacement({ top: bounds.top + 8, right: window.innerWidth - bounds.right + 8, maxWidth: Math.max(0, bounds.width - 16) });
      const next: Box[] = [];
      capturedMatches.forEach(({ range }, matchIndex) => {
        if (!range.startContainer.isConnected) return;
        let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
        for (let parent = range.startContainer.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (/auto|scroll|hidden|clip/.test(style.overflowX + style.overflowY)) {
            const bounds = parent.getBoundingClientRect();
            if (style.overflowX !== "visible") { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
            if (style.overflowY !== "visible") { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
            const composer = composerBounds(parent);
            if (composer) bottom = Math.min(bottom, composer.top);
          }
        }
        for (const rect of range.getClientRects()) {
          const x = Math.max(left, rect.left), y = Math.max(top, rect.top);
          const width = Math.min(right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y;
          if (width > 0 && height > 0) next.push({ left: x, top: y, width, height, active: matchIndex === capturedIndex });
        }
      });
      setBoxes(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    draw();
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    const root = document.querySelector<HTMLElement>(capturedSelector1);
    if (root) observer.observe(root);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); };
  }, () => [open(), matches(), index(), componentProps.selector, componentProps.scopeKey, (componentProps.enabled === undefined ? true : componentProps.enabled)]);

  return <>{!open() || !(componentProps.enabled === undefined ? true : componentProps.enabled) ? (null) : (<>
    <div class="find-highlights" aria-hidden="true">{<Index each={boxes()}>{(box, i) => <span  class={box().active ? "active" : undefined} style={{ left: cssPixels(box().left), top: cssPixels(box().top), width: cssPixels(box().width), height: cssPixels(box().height) }} />}</Index>}</div>
    <section ref={element => { bar.current = element; }} oncapture:focus={componentProps.onActivate} oncapture:pointerdown={componentProps.onActivate} style={placement() ? { top: `${placement()!.top}px`, right: `${placement()!.right}px`, "max-width": `${placement()!.maxWidth}px` } : undefined} class="find-bar" aria-label="Find in page" role="search">
      <Search size={15} aria-hidden="true" />
      <input ref={element => { input.current = element; }} aria-label="Find in page" placeholder="Find in page…" value={query()} onInput={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
      }} />
      <span class="find-count" role="status">{query() ? matches().length ? `${index() + 1} / ${matches().length}` : "No matches" : ""}</span>
      <button aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches().length} onClick={() => move(-1)}><ArrowUp size={15} /></button>
      <button aria-label="Next match" title="Next match (Enter)" disabled={!matches().length} onClick={() => move(1)}><ArrowDown size={15} /></button>
      <button aria-label="Close find" title="Close (Escape)" onClick={close}><X size={15} /></button>
    </section>
  </>)}</>;
}
