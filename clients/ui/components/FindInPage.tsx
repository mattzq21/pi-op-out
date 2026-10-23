import { required } from "../lib/required";
import { createSignal, Index } from "solid-js";
import { createDependencyEffect, createRef, cssPixels } from "../lib/solid";

import { ArrowDown, ArrowUp, Search, X } from "lucide-solid";

type Match = { range: Range };

type Box = { left: number; top: number; width: number; height: number; active: boolean };

type Bounds = { left: number; top: number; right: number; bottom: number };

function sharedTextMatch(matches: Match[], index: number) {
  const range = matches[index].range;

  return range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE
    && [matches[index - 1], matches[index + 1]].some(match => match?.range.startContainer === range.startContainer && match.range.endContainer === range.startContainer);
}

function textOutside(range: Range, clip: Bounds, cache: Map<Node, DOMRect>) {
  const node = range.startContainer;
  let bounds = cache.get(node);

  if (!bounds) {
    const entire = document.createRange();
    entire.selectNodeContents(node);
    bounds = entire.getBoundingClientRect();
    cache.set(node, bounds);
  }

  return bounds.right <= clip.left || bounds.left >= clip.right || bounds.bottom <= clip.top || bounds.top >= clip.bottom;
}

function searchableTextNode(node: Node) {
  if (!(node instanceof Text) || !node.data) return undefined;
  const parent = node.parentElement;

  if (!parent || parent.closest('script, style, textarea, input, [hidden], [aria-hidden="true"]')) return undefined;

  return { node, parent };
}

function findMatches(root: HTMLElement, query: string): Match[] {
  if (!query) return [];
  const collapsedQuery = query.replace(/\s+/g, " ");
  const pattern = new RegExp(collapsedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "giu");
  const matches: Match[] = [];
  let block: Element | null = null;
  let text = "";
  let trailingSpace = false;
  let offsets: Array<{ node: Text; start: number; end: number }> = [];
  let pending: Array<{ node: Text; collapse: boolean }> = [];

  const flush = () => {
    const candidate = pattern.test(pending.map(({ node }) => node.data).join(""));
    pattern.lastIndex = 0;

    if (candidate) pending.forEach(({ node, collapse }) => appendNode(node, collapse));
    pending = [];

    for (const found of text.matchAll(pattern)) {
      const start = found.index, end = start + found[0].length;
      const first = offsets[start], last = offsets[end - 1];

      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, first.start);
      range.setEnd(last.node, last.end);

      if (range.getClientRects().length) matches.push({ range });
    }

    text = ""; trailingSpace = false; offsets = [];
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  const appendNode = (node: Text, collapse: boolean) => {
    const data = node.data;

    for (let i = 0; i < data.length; i++) {
      const char = collapse && /[ \t\r\n\f]/.test(data[i]) ? " " : data[i];

      if (collapse && char === " " && trailingSpace) { if (offsets[offsets.length - 1].node === node) offsets[offsets.length - 1].end = i + 1; continue; }

      trailingSpace = char === " ";
      text += char; offsets.push({ node, start: i, end: i + 1 });
    }
  };

  while (walker.nextNode()) {
    const candidate = searchableTextNode(walker.currentNode);

    if (!candidate) continue;
    const { node, parent } = candidate;
    const style = getComputedStyle(parent);

    if (style.visibility === "hidden" || !parent.getClientRects().length) continue;
    const nextBlock = parent.closest("p, pre, li, h1, h2, h3, h4, h5, h6, td, th, summary, button, label, .message-body") ?? parent;

    if (block !== nextBlock) { flush(); block = nextBlock; }

    const collapse = !["pre", "pre-wrap", "break-spaces"].includes(style.whiteSpace);
    pending.push({ node, collapse });
  }

  flush();

  return matches;
}

function composerBounds(element: Element) {
  return element.classList.contains("messages") ? element.closest(".chat-shell")?.querySelector(".composer-stack")?.getBoundingClientRect() : undefined;
}

function clippingBounds() {
  const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const cache = new Map<Element, typeof viewport>();

  const read = (element: Element | null): typeof viewport => {
    if (!element) return viewport;
    const cached = cache.get(element);

    if (cached) return cached;
    const result = { ...read(element.parentElement) };
    const style = getComputedStyle(element);

    if (/auto|scroll|hidden|clip/.test(style.overflowX + style.overflowY)) {
      const bounds = element.getBoundingClientRect();

      if (style.overflowX !== "visible") { result.left = Math.max(result.left, bounds.left); result.right = Math.min(result.right, bounds.right); }

      if (style.overflowY !== "visible") { result.top = Math.max(result.top, bounds.top); result.bottom = Math.min(result.bottom, bounds.bottom); }

      const composer = composerBounds(element);

      if (composer) result.bottom = Math.min(result.bottom, composer.top);
    }

    cache.set(element, result);

    return result;
  };

  return read;
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

  if (focused?.closest(".keybind-input, .cm-editor") || (event.target instanceof Element && event.target.closest(".keybind-input, .cm-editor"))) return false;
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
  const rememberFocus = () => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };

  const selected = createRef<Match | undefined>(undefined);
  let scheduleDraw = () => {};

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

        if (!capturedOpen) rememberFocus();
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

  createDependencyEffect(() => {
    const root = document.querySelector<HTMLElement>(componentProps.selector);

    if (!root) return;
    const searching = open() && componentProps.enabled !== false;
    root.toggleAttribute("data-find-open", searching);
    root.dispatchEvent(new CustomEvent("piop:find-open", { detail: searching }));

    return () => {
      root.removeAttribute("data-find-open");
      root.dispatchEvent(new CustomEvent("piop:find-open", { detail: false }));
    };
  }, () => [open(), componentProps.enabled, componentProps.selector, componentProps.scopeKey]);

  createDependencyEffect(() => { const capturedOpen = open(); const capturedQuery = query(); const capturedEnabled0 = componentProps.enabled; const capturedSelector1 = componentProps.selector;

    if (!capturedOpen || !(capturedEnabled0 === undefined ? true : capturedEnabled0)) { setMatches([]); setBoxes([]);

    return; }

    const root = document.querySelector<HTMLElement>(capturedSelector1);

    if (!root) { setMatches([]); setBoxes([]);

    return; }

    let timer = 0;

    const scan = (keepCurrent: boolean) => {
      const next = findMatches(root, capturedQuery), old = keepCurrent ? selected.current?.range : undefined;
      const found = old ? next.findIndex(item => item.range.startContainer === old.startContainer && item.range.startOffset === old.startOffset) : -1;
      const active = Math.max(0, found);
      selected.current = next[active]; setMatches(next); setIndex(active);

      if (!keepCurrent && next[active]) reveal(next[active].range);
    };

    scan(false);

    const observer = new MutationObserver((records) => {
      if (!records.some((record) => {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;

        return !element?.closest("textarea, input");
      })) return;
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
      const clip = clippingBounds();
      const textBounds = new Map<Node, DOMRect>();
      capturedMatches.forEach(({ range }, matchIndex) => {
        if (!range.startContainer.isConnected) return;
        const { left, top, right, bottom } = clip(range.startContainer.parentElement);

        if (sharedTextMatch(capturedMatches, matchIndex) && textOutside(range, { left, top, right, bottom }, textBounds)) return;

        for (const rect of range.getClientRects()) {
          const x = Math.max(left, rect.left), y = Math.max(top, rect.top);
          const width = Math.min(right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y;

          if (width > 0 && height > 0) next.push({ left: x, top: y, width, height, active: matchIndex === capturedIndex });
        }
      });
      setBoxes(next);
    };

    scheduleDraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

    draw();

    return () => { cancelAnimationFrame(frame); scheduleDraw = () => {}; };
  }, () => [open(), matches(), index(), componentProps.selector, componentProps.scopeKey, (componentProps.enabled === undefined ? true : componentProps.enabled)]);

  createDependencyEffect(() => {
    if (!open() || componentProps.enabled === false) return;
    const root = document.querySelector<HTMLElement>(componentProps.selector);
    const schedule = () => scheduleDraw();

    const onScroll = (event: Event) => {
      const target = event.target;

      if (!root || !(target instanceof Node) || root.contains(target) || target.contains(root)) schedule();
    };

    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);

    if (root) observer.observe(root);
    const composer = root?.querySelector(".composer-stack");

    if (composer) observer.observe(composer);

    return () => { observer.disconnect(); document.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", schedule); };
  }, () => [open(), componentProps.selector, componentProps.scopeKey, componentProps.enabled]);

  return <>{!open() || !(componentProps.enabled === undefined ? true : componentProps.enabled) ? (null) : (<>
    <div class="find-highlights" aria-hidden="true">{<Index each={boxes()}>{(box, _i) => <span  class={box().active ? "active" : undefined} style={{ left: cssPixels(box().left), top: cssPixels(box().top), width: cssPixels(box().width), height: cssPixels(box().height) }} />}</Index>}</div>
    <section ref={element => { bar.current = element; }} oncapture:focus={componentProps.onActivate} oncapture:pointerdown={componentProps.onActivate} style={placement() ? { top: `${required(placement()).top}px`, right: `${required(placement()).right}px`, "max-width": `${required(placement()).maxWidth}px` } : undefined} class="find-bar" aria-label="Find in page" role="search">
      <Search size={15} aria-hidden="true" />
      <input ref={element => { input.current = element; }} aria-label="Find in page" placeholder="Find in page…" value={query()} onInput={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
      }} />
      <span class="find-count" role="status">{query() ? matches().length ? `${index() + 1} / ${matches().length}` : "No matches" : ""}</span>
      <button aria-label="Previous match" data-tooltip="Previous match (Shift+Enter)" disabled={!matches().length} onClick={() => move(-1)}><ArrowUp size={15} /></button>
      <button aria-label="Next match" data-tooltip="Next match (Enter)" disabled={!matches().length} onClick={() => move(1)}><ArrowDown size={15} /></button>
      <button aria-label="Close find" data-tooltip="Close (Escape)" onClick={close}><X size={15} /></button>
    </section>
  </>)}</>;
}
