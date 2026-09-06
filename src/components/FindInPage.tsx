import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";

type Match = { range: Range };
type Box = { left: number; top: number; width: number; height: number; active: boolean };

function findMatches(root: HTMLElement, query: string): Match[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const matches: Match[] = [];
  let block: Element | null = null;
  let nodes: Array<{ node: Text; start: number; end: number }> = [];
  let text = "";
  const flush = () => {
    for (const found of text.matchAll(pattern)) {
      const start = found.index!, end = start + found[0].length;
      const first = nodes.find(item => item.end > start), last = nodes.find(item => item.end >= end);
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      if (range.getClientRects().length) matches.push({ range });
    }
    nodes = []; text = "";
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, parent = node.parentElement;
    if (!parent || !node.data || parent.closest('script, style, textarea, input, [hidden], [aria-hidden="true"]')) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === "hidden" || !parent.getClientRects().length) continue;
    const nextBlock = parent.closest("p, pre, li, h1, h2, h3, h4, h5, h6, td, th, summary, button, label, .message-body") ?? parent;
    if (block !== nextBlock) { flush(); block = nextBlock; }
    nodes.push({ node, start: text.length, end: text.length + node.data.length });
    text += node.data;
  }
  flush();
  return matches;
}

function reveal(range: Range) {
  for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
    const style = getComputedStyle(element), bounds = element.getBoundingClientRect(), target = range.getBoundingClientRect();
    const composer = element.classList.contains("messages") ? element.closest(".chat-shell")?.querySelector(".composer-stack")?.getBoundingClientRect() : undefined;
    const bottom = composer ? Math.min(bounds.bottom, composer.top) : bounds.bottom;
    if (/auto|scroll/.test(style.overflowY) && (target.top < bounds.top || target.bottom > bottom)) {
      element.scrollTop += target.top - bounds.top - (bottom - bounds.top) / 2;
    }
    if (/auto|scroll/.test(style.overflowX) && (target.left < bounds.left || target.right > bounds.right)) {
      element.scrollLeft += target.left - bounds.left - element.clientWidth / 2;
    }
  }
}

export function FindInPage({ selector, scopeKey, active = true, enabled = true, onActivate }: { selector: string; scopeKey: string; active?: boolean; enabled?: boolean; onActivate?: () => void }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ top: number; right: number; maxWidth: number }>();
  const bar = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [index, setIndex] = useState(0);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const selected = useRef<Match | undefined>(undefined);
  const close = useCallback(() => {
    setOpen(false);
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
  }, []);
  const move = useCallback((direction: number) => {
    if (!matches.length) return;
    const next = (index + direction + matches.length) % matches.length;
    selected.current = matches[next]; setIndex(next); reveal(matches[next].range);
  }, [index, matches]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!enabled || event.isComposing || document.querySelector("dialog[open]")) return;
      const root = document.querySelector<HTMLElement>(selector);
      const focused = document.activeElement;
      const focusedBar = focused?.closest(".find-bar");
      const focusedShell = focused?.closest(".chat-shell");
      if (focusedBar ? focusedBar !== bar.current : focusedShell ? focusedShell !== root : !active) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault(); event.stopImmediatePropagation();

        if (!open) previousFocus.current = document.activeElement as HTMLElement;
        setOpen(true);
        requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
      } else if (open && event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); close();
      } else if (open && event.key === "F3") {
        event.preventDefault(); event.stopImmediatePropagation(); move(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close, move, selector, active, enabled]);

  useLayoutEffect(() => {
    if (!open || !enabled) { setMatches([]); setBoxes([]); return; }
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) { setMatches([]); setBoxes([]); return; }
    let timer = 0;
    const scan = (keepCurrent: boolean) => {
      const next = findMatches(root, query), old = keepCurrent ? selected.current?.range : undefined;
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
  }, [open, query, selector, scopeKey, enabled]);

  useLayoutEffect(() => {
    if (!open || !enabled) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const bounds = document.querySelector(selector)?.getBoundingClientRect();
      if (bounds) setPlacement({ top: bounds.top + 8, right: window.innerWidth - bounds.right + 8, maxWidth: Math.max(0, bounds.width - 16) });
      const next: Box[] = [];
      matches.forEach(({ range }, matchIndex) => {
        if (!range.startContainer.isConnected) return;
        let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
        for (let parent = range.startContainer.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (/auto|scroll|hidden|clip/.test(style.overflowX + style.overflowY)) {
            const bounds = parent.getBoundingClientRect();
            if (style.overflowX !== "visible") { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
            if (style.overflowY !== "visible") { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
            if (parent.classList.contains("messages")) {
              const composer = parent.closest(".chat-shell")?.querySelector(".composer-stack");
              if (composer) bottom = Math.min(bottom, composer.getBoundingClientRect().top);
            }
          }
        }
        for (const rect of range.getClientRects()) {
          const x = Math.max(left, rect.left), y = Math.max(top, rect.top);
          const width = Math.min(right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y;
          if (width > 0 && height > 0) next.push({ left: x, top: y, width, height, active: matchIndex === index });
        }
      });
      setBoxes(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    draw();
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    const root = document.querySelector<HTMLElement>(selector);
    if (root) observer.observe(root);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); };
  }, [open, matches, index, selector, scopeKey, enabled]);

  if (!open || !enabled) return null;
  return <>
    <div className="find-highlights" aria-hidden="true">{boxes.map((box, i) => <span key={i} className={box.active ? "active" : undefined} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />)}</div>
    <section ref={bar} onFocusCapture={onActivate} onPointerDownCapture={onActivate} style={placement} className="find-bar" aria-label="Find in page" role="search">
      <Search size={15} aria-hidden="true" />
      <input ref={input} aria-label="Find in page" placeholder="Find in page…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
      }} />
      <span className="find-count" role="status">{query ? matches.length ? `${index + 1} / ${matches.length}` : "No matches" : ""}</span>
      <button aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => move(-1)}><ArrowUp size={15} /></button>
      <button aria-label="Next match" title="Next match (Enter)" disabled={!matches.length} onClick={() => move(1)}><ArrowDown size={15} /></button>
      <button aria-label="Close find" title="Close (Escape)" onClick={close}><X size={15} /></button>
    </section>
  </>;
}
