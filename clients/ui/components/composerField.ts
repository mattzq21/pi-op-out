import { findSkillReference, queuedSkillPrompt } from "../lib/composerPrompt";
import { sessionReference } from "../lib/sessionDrop";

export const COMPOSER_FIELD_TAG = "piop-composer-field";

const SESSION_LINK = /\[((?:\\.|[^\\\]\n])*)\]\((piop:\/\/session\/[^/()\s]+\/[^/()\s]+)\)/g;

export type Segment = { text: string } | { markdown: string; label: string; hostId: string; sessionId: string };

export function sessionLinkSegments(value: string): Segment[] {
  const result: Segment[] = [];
  let last = 0;

  for (const match of value.matchAll(SESSION_LINK)) {
    const target = sessionReference(match[2]);
    if (!target) continue;

    if (match.index > last) result.push({ text: value.slice(last, match.index) });
    result.push({ markdown: match[0], label: match[1].replace(/\\(.)/g, "$1"), ...target });
    last = match.index + match[0].length;
  }

  if (last < value.length) result.push({ text: value.slice(last) });

  return result;
}

export type FieldSegment = Segment | { skill: string };

export function queuedSegments(value: string): FieldSegment[] {
  const call = queuedSkillPrompt(value);

  return call ? fieldSegments(call.text, new Map([[call.skill.toLowerCase(), call.skill]])) : sessionLinkSegments(value);
}

function fieldSegments(value: string, skills: ReadonlyMap<string, string>): FieldSegment[] {
  const segments: FieldSegment[] = sessionLinkSegments(value);
  const skill = findSkillReference(value, skills);

  if (!skill) return segments;
  let at = 0;

  return segments.flatMap((segment): FieldSegment[] => {
    const start = at;
    at += "markdown" in segment ? segment.markdown.length : "text" in segment ? segment.text.length : segment.skill.length;

    if (!("text" in segment) || skill.start < start || skill.end > at) return [segment];
    const before = segment.text.slice(0, skill.start - start);
    const after = segment.text.slice(skill.end - start);

    return [...before ? [{ text: before }] : [], { skill: segment.text.slice(skill.start - start, skill.end - start) }, ...after ? [{ text: after }] : []];
  });
}

const isSkillMark = (node: Node) => node instanceof HTMLElement && node.classList.contains("composer-skill");

const linkMarkdown = (node: Node) => node instanceof HTMLElement ? node.dataset.markdown : undefined;

const FILLER = "\u200B";
const fillers = new WeakSet<Text>();

function filler() {
  const node = document.createTextNode(FILLER);
  fillers.add(node);

  return node;
}

const textLength = (node: Text, offset: number) => fillers.has(node) ? node.data.slice(0, offset).replaceAll(FILLER, "").length : offset;

const placeholderBreak = (node: Node) => node.nodeName === "BR" && !node.nextSibling;

function nodeText(node: Node): string {
  if (node instanceof Text) return fillers.has(node) ? node.data.replaceAll(FILLER, "") : node.data;
  const markdown = linkMarkdown(node);

  if (markdown !== undefined) return markdown;

  if (node.nodeName === "BR") return placeholderBreak(node) ? "" : "\n";
  let text = "";
  node.childNodes.forEach(child => { text += nodeText(child); });

  return /^(DIV|P)$/.test(node.nodeName) && node.previousSibling ? "\n" + text : text;
}

type Snapshot = { value: string; selection: { start: number; end: number } };

const GROUP_TIME = 1000;
const HISTORY_LIMIT = 200;

function editKind(event: Event) {
  if (!(event instanceof InputEvent)) return undefined;

  if (event.inputType === "insertText") return "insertText";

  return event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward" ? event.inputType : undefined;
}

function withFillers(segments: FieldSegment[]): (FieldSegment | { filler: true })[] {
  return segments.flatMap((segment, index): (FieldSegment | { filler: true })[] => {
    if (!("markdown" in segment)) return [segment];
    const previous = segments[index - 1];
    const next = segments[index + 1];

    return [...previous && "markdown" in previous ? [] : [{ filler: true as const }], segment, ...next && "text" in next ? [] : [{ filler: true as const }]];
  });
}

export class ComposerFieldElement extends HTMLElement {
  #value = "";
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  #group: { kind: string; at: number } | undefined;
  #before: Snapshot | undefined;
  #selection = { start: 0, end: 0 };
  #readOnly = false;
  #skills: ReadonlyMap<string, string> = new Map();
  #composing = false;

  constructor() {
    super();
    this.addEventListener("beforeinput", this.#beforeInput);
    this.addEventListener("input", this.#input);
    this.addEventListener("compositionstart", () => { this.#composing = true; });
    this.addEventListener("compositionend", event => { this.#composing = false; this.#input(event); });
    this.addEventListener("focus", this.#focus);
    this.addEventListener("copy", this.#copy);
    this.addEventListener("cut", this.#copy);
    this.addEventListener("keydown", this.#keyDown);
  }

  connectedCallback() {
    this.setAttribute("role", "textbox");
    this.setAttribute("aria-multiline", "true");
    this.setAttribute("data-custom-history", "");

    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    this.#applyEditable();
    this.#render();
    document.addEventListener("selectionchange", this.#selectionChange);
  }

  disconnectedCallback() { document.removeEventListener("selectionchange", this.#selectionChange); }

  get value() { return this.#value; }

  set value(next: string) {
    next ??= "";

    if (next === this.#value && (this.#composing || this.#canonical())) return;
    const focused = this.#focused();

    if (next !== this.#value && this.isConnected) { this.#before = undefined; this.#record(this.#snapshot()); }
    this.#value = next;
    this.#render();
    this.#selection = { start: Math.min(this.#selection.start, next.length), end: Math.min(this.#selection.end, next.length) };

    if (focused) this.#applySelection();
  }

  clearHistory() { this.#undo = []; this.#redo = []; this.#group = undefined; this.#before = undefined; }

  get readOnly() { return this.#readOnly; }

  set readOnly(next: boolean) { this.#readOnly = Boolean(next); this.#applyEditable(); }

  get skills() { return this.#skills; }

  set skills(next: ReadonlyMap<string, string>) {
    this.#skills = next ?? new Map();

    if (this.#composing || this.#canonical()) return;
    const focused = this.#focused();

    if (focused) this.#readSelection();
    this.#render();

    if (focused) this.#applySelection();
  }

  get placeholder() { return this.getAttribute("placeholder") ?? ""; }

  set placeholder(next: string) { if (next) this.setAttribute("placeholder", next); else this.removeAttribute("placeholder"); }

  get selectionStart() { this.#readSelection(); return this.#selection.start; }

  get selectionEnd() { this.#readSelection(); return this.#selection.end; }

  setSelectionRange(start: number, end: number) {
    const length = this.#value.length;
    const from = Math.max(0, Math.min(start, length));
    this.#selection = { start: from, end: Math.max(from, Math.min(end, length)) };

    if (!this.#composing && !this.#canonical()) this.#render();

    if (this.#focused()) this.#applySelection();
  }

  dropOffset(x: number, y: number) {
    const bounds = this.getBoundingClientRect();

    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) { this.#readSelection(); return this.#selection.end; }
    const caret = document.caretPositionFromPoint?.(x, y);
    const range = caret ? undefined : document.caretRangeFromPoint?.(x, y);
    const node = caret?.offsetNode ?? range?.startContainer;
    const offset = caret?.offset ?? range?.startOffset ?? 0;

    return node && this.contains(node) ? this.#offset(node, offset) : this.#value.length;
  }

  showDropCaret(offset: number | undefined) {
    if (offset === undefined) { this.removeAttribute("data-drop-caret"); return; }
    const rect = this.#caretRect(offset);
    const bounds = this.getBoundingClientRect();
    this.style.setProperty("--drop-x", `${rect.left - bounds.left - this.clientLeft + this.scrollLeft}px`);
    this.style.setProperty("--drop-y", `${rect.top - bounds.top - this.clientTop + this.scrollTop}px`);
    this.style.setProperty("--drop-height", `${rect.height}px`);
    this.setAttribute("data-drop-caret", "");
  }

  insertAt(offset: number, text: string) {
    const at = Math.max(0, Math.min(offset, this.#value.length));
    this.#readSelection();
    this.#record(this.#snapshot());
    this.#value = this.#value.slice(0, at) + text + this.#value.slice(at);
    this.#render();
    this.#selection = { start: at + text.length, end: at + text.length };

    if (this.#focused()) this.#applySelection();
    this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromDrop", data: text }));
  }

  #caretRect(offset: number) {
    const [node, at] = this.#position(offset);
    const range = document.createRange();
    range.setStart(node, at);
    const rect = range.getClientRects()[0];

    if (rect) return rect;
    const lineHeight = parseFloat(getComputedStyle(this).lineHeight) || 20;
    const after = node === this ? this.childNodes[at] : undefined;
    const before = node === this ? this.childNodes[at - 1] : undefined;
    const box = (child: ChildNode) => { const span = document.createRange(); span.selectNode(child);

      return span.getClientRects(); };
    const next = after && after.nodeName !== "BR" ? box(after)[0] : undefined;

    if (next) return new DOMRect(next.left, next.top, 0, next.height);
    const previous = before ? box(before) : undefined;
    const last = previous?.[previous.length - 1];

    if (last && before?.nodeName !== "BR") return new DOMRect(last.right, last.top, 0, last.height);
    const bounds = this.getBoundingClientRect();
    const style = getComputedStyle(this);
    const top = last ? last.bottom : bounds.top + this.clientTop + parseFloat(style.paddingTop);

    return new DOMRect(bounds.left + this.clientLeft + parseFloat(style.paddingLeft), top, 0, lineHeight);
  }

  #applyEditable() {
    if (!this.isConnected) return;
    this.setAttribute("contenteditable", this.#readOnly ? "false" : "plaintext-only");
    this.setAttribute("aria-readonly", String(this.#readOnly));
  }

  #focused() { return document.activeElement === this; }

  #canonical() {
    const plan = withFillers(fieldSegments(this.#value, this.#skills));
    const nodes = Array.from(this.childNodes).filter(node => !(node instanceof Text) || node.data);
    const placeholder = this.#value.endsWith("\n") ? 1 : 0;

    if (nodes.length !== plan.length + placeholder || (placeholder && nodes.at(-1)?.nodeName !== "BR")) return false;

    return plan.every((segment, index) => {
      const node = nodes[index];

      if ("filler" in segment) return node instanceof Text && fillers.has(node) && node.data === FILLER;

      if ("text" in segment) return node instanceof Text && !fillers.has(node) && node.data === segment.text;

      if ("skill" in segment) return isSkillMark(node) && node.childNodes.length === 1 && node.firstChild instanceof Text && node.textContent === segment.skill;

      return linkMarkdown(node) === segment.markdown && node.textContent === segment.label;
    });
  }

  #render() {
    const nodes: Node[] = withFillers(fieldSegments(this.#value, this.#skills)).map(segment => {
      if ("filler" in segment) return filler();

      if ("text" in segment) return document.createTextNode(segment.text);

      if ("skill" in segment) {
        const mark = document.createElement("span");
        mark.className = "composer-skill";
        mark.textContent = segment.skill;

        return mark;
      }
      const link = document.createElement("span");
      link.className = "composer-session-link";
      link.setAttribute("contenteditable", "false");
      link.dataset.markdown = segment.markdown;
      link.textContent = segment.label;

      return link;
    });

    if (this.#value.endsWith("\n")) nodes.push(document.createElement("br"));
    this.replaceChildren(...nodes);
    this.#markSelectedLinks(this.#focused());
  }

  #offset(node: Node, offset: number) {
    const children = Array.from(this.childNodes);
    const before = (count: number) => children.slice(0, count).reduce((sum, child) => sum + nodeText(child).length, 0);

    if (node === this) return before(offset);
    let top: Node | null = node;

    while (top && top.parentNode !== this) top = top.parentNode;

    if (!top) return this.#value.length;
    const start = before(children.indexOf(top as ChildNode));

    if (node === top && top instanceof Text) return start + textLength(top, offset);

    if (isSkillMark(top) && node !== top) return start + Math.min(offset, nodeText(top).length);

    return start + (node === top && offset === 0 ? 0 : nodeText(top).length);
  }

  #position(offset: number): [Node, number] {
    let remaining = offset;
    const children = Array.from(this.childNodes);

    for (const [index, child] of children.entries()) {
      const length = nodeText(child).length;

      if (child instanceof Text && remaining <= length) return [child, remaining];

      if (remaining === 0) return [this, index];

      if (isSkillMark(child) && child.firstChild && remaining < length) return [child.firstChild, remaining];

      if (remaining < length) return [this, index + 1];
      remaining -= length;
    }

    const last = children.at(-1);

    return [this, children.length - (last && placeholderBreak(last) ? 1 : 0)];
  }

  #readSelection() {
    const selection = document.getSelection();

    if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode || !this.contains(selection.anchorNode) || !this.contains(selection.focusNode)) return false;
    const anchor = this.#offset(selection.anchorNode, selection.anchorOffset);
    const focus = this.#offset(selection.focusNode, selection.focusOffset);
    this.#selection = { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };

    return true;
  }

  #applySelection() {
    const selection = document.getSelection();

    if (!selection) return;
    const [startNode, startOffset] = this.#position(this.#selection.start);
    const [endNode, endOffset] = this.#position(this.#selection.end);
    selection.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
  }

  #snapshot(): Snapshot { return { value: this.#value, selection: { ...this.#selection } }; }

  #record(before: Snapshot, kind?: string) {
    const now = performance.now();
    const joins = kind !== undefined && this.#group?.kind === kind && now - this.#group.at < GROUP_TIME;
    this.#group = kind === undefined ? undefined : { kind, at: now };
    this.#redo = [];

    if (joins) return;
    this.#undo.push(before);

    if (this.#undo.length > HISTORY_LIMIT) this.#undo.shift();
  }

  #restore(from: Snapshot[], to: Snapshot[], inputType: "historyUndo" | "historyRedo") {
    const target = from.pop();

    if (!target) return;
    this.#readSelection();
    to.push(this.#snapshot());
    this.#group = undefined;
    this.#value = target.value;
    this.#selection = { ...target.selection };
    this.#render();

    if (this.#focused()) this.#applySelection();
    this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  }

  #history(command: "undo" | "redo") {
    if (this.#readOnly || this.#composing) return;

    if (command === "undo") this.#restore(this.#undo, this.#redo, "historyUndo");
    else this.#restore(this.#redo, this.#undo, "historyRedo");
  }

  #skipFiller(event: KeyboardEvent) {
    const forward = event.key === "ArrowRight" || event.key === "Delete";

    if (!forward && event.key !== "ArrowLeft" && event.key !== "Backspace") return;
    const selection = document.getSelection();
    const focus = selection?.focusNode;
    const next = focus instanceof Text && !fillers.has(focus) && selection?.focusOffset === (forward ? focus.length : 0) ? forward ? focus.nextSibling : focus.previousSibling : focus;
    const node = next instanceof Text && fillers.has(next) ? next : focus;

    if (!selection || !(node instanceof Text) || !fillers.has(node) || node.data !== FILLER || node.parentNode !== this) return;
    const arrow = event.key.startsWith("Arrow");

    if (!selection.isCollapsed && !(arrow && event.shiftKey)) return;
    const at = forward ? FILLER.length : 0;

    if (arrow && event.shiftKey) selection.extend(node, at);
    else selection.collapse(node, at);
  }

  #keyDown = (event: KeyboardEvent) => {
    if (!event.isComposing) this.#skipFiller(event);

    if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();

    if (key !== "z" && key !== "y") return;
    event.preventDefault();

    if (!event.shiftKey) this.#history(key === "z" ? "undo" : "redo");
  };

  #replaceSelection(text: string, inputType: string) {
    this.#readSelection();
    const { start, end } = this.#selection;
    this.#record(this.#snapshot());
    this.#value = this.#value.slice(0, start) + text + this.#value.slice(end);
    this.#render();
    this.#selection = { start: start + text.length, end: start + text.length };
    this.#applySelection();
    this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text || null }));
  }

  #beforeInput = (event: InputEvent) => {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      this.#history(event.inputType === "historyUndo" ? "undo" : "redo");

      return;
    }

    if (!this.#before && event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") {
      this.#readSelection();
      this.#before = this.#snapshot();
    }

    if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return;
    event.preventDefault();

    if (!this.#readOnly && !this.#composing && !event.isComposing) this.#replaceSelection("\n", "insertLineBreak");
  };

  #input = (event: Event) => {
    this.#readSelection();
    const before = this.#before ?? this.#snapshot();
    this.#value = nodeText(this);
    const composing = this.#composing || (event instanceof InputEvent && event.isComposing);

    if (!composing) {
      this.#before = undefined;

      const kind = editKind(event);

      if (event instanceof InputEvent && event.inputType === "insertText" && event.data && /\s/.test(event.data)) this.#group = undefined;

      if (before.value !== this.#value) this.#record(before, kind);
    }

    if (this.#composing || (event instanceof InputEvent && event.isComposing) || this.#canonical()) return;
    this.#render();
    this.#applySelection();
  };

  #focus = () => { if (!this.#readSelection()) this.#applySelection(); };

  #copy = (event: ClipboardEvent) => {
    if (!event.clipboardData || !this.#readSelection()) return;
    const { start, end } = this.#selection;

    if (start === end) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", this.#value.slice(start, end));

    if (event.type === "cut" && !this.#readOnly) this.#replaceSelection("", "deleteByCut");
  };

  #selectionChange = () => {
    const before = this.#selection;
    const inside = this.#readSelection();

    if (inside) this.#leaveFillerEnd();
    this.#markSelectedLinks(inside);

    if (inside && (before.start !== this.#selection.start || before.end !== this.#selection.end)) this.dispatchEvent(new Event("select"));
  };

  #leaveFillerEnd() {
    const selection = document.getSelection();

    if (!selection?.anchorNode || !selection.focusNode || selection.isCollapsed) return;
    const start = (node: Node, offset: number): [Node, number] => node instanceof Text && fillers.has(node) && offset > 0 && node.nextSibling && linkMarkdown(node.nextSibling) !== undefined ? [node, 0] : [node, offset];
    const anchor = start(selection.anchorNode, selection.anchorOffset);
    const focus = start(selection.focusNode, selection.focusOffset);

    if (anchor[1] !== selection.anchorOffset || focus[1] !== selection.focusOffset) selection.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
  }

  #markSelectedLinks(inside: boolean) {
    const { start, end } = this.#selection;
    let at = 0;

    for (const child of Array.from(this.childNodes)) {
      const length = nodeText(child).length;

      if (child instanceof HTMLElement && linkMarkdown(child) !== undefined) child.classList.toggle("selected", inside && start < end && start <= at && at + length <= end);
      at += length;
    }
  }
}

if (!customElements.get(COMPOSER_FIELD_TAG)) customElements.define(COMPOSER_FIELD_TAG, ComposerFieldElement);

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "piop-composer-field": HTMLAttributes<ComposerFieldElement> & { value?: string; skills?: ReadonlyMap<string, string>; readOnly?: boolean; placeholder?: string };
    }
  }
}
