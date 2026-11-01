import { findSkillReference, queuedSkillPrompt } from "../lib/composerPrompt";
import { sessionReference } from "../lib/sessionDrop";

/**
 * The message box of the composer. It works like a textarea: `value`, `selectionStart`, `selectionEnd`, `setSelectionRange`,
 * `readOnly`, `placeholder`, and "input" and "select" events. All offsets are offsets in `value`, the Markdown text.
 * Links to chats show as links. Each link is one unit: the caret goes before or after it, never into it.
 * The `$skill` reference that the message uses shows highlighted. It stays normal editable text.
 * Ctrl+Z undoes and Ctrl+Y redoes each change of `value`, also changes that the app makes.
 */
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

/** The segments of `value`, with the used skill reference split out of its text segment. */
export type FieldSegment = Segment | { skill: string };

/** The segments of a queued message. A queued `/skill:name` call shows the prompt that the user wrote, with its skill reference highlighted. */
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

/** A <br> as the last child only keeps an empty last line visible. It is not text. */
const placeholderBreak = (node: Node) => node.nodeName === "BR" && !node.nextSibling;

function nodeText(node: Node): string {
  if (node instanceof Text) return node.data;
  const markdown = linkMarkdown(node);

  if (markdown !== undefined) return markdown;

  if (node.nodeName === "BR") return placeholderBreak(node) ? "" : "\n";
  let text = "";
  node.childNodes.forEach(child => { text += nodeText(child); });

  return /^(DIV|P)$/.test(node.nodeName) && node.previousSibling ? "\n" + text : text;
}

type Snapshot = { value: string; selection: { start: number; end: number } };

/** Typing of the same kind within this time is one undo step. */
const GROUP_TIME = 1000;
const HISTORY_LIMIT = 200;

/** The kind of a user edit that can join the undo step of the edit before it. Other edits are a step each. */
function editKind(event: Event) {
  if (!(event instanceof InputEvent)) return undefined;

  if (event.inputType === "insertText") return "insertText";

  return event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward" ? event.inputType : undefined;
}

export class ComposerFieldElement extends HTMLElement {
  #value = "";
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  /** The kind and time of the last recorded user edit. Next edits of the same kind join its undo step. */
  #group: { kind: string; at: number } | undefined;
  /** The state before the user edit that the browser does now. */
  #before: Snapshot | undefined;
  #selection = { start: 0, end: 0 };
  #readOnly = false;
  #skills: ReadonlyMap<string, string> = new Map();
  /** An input method is composing text. The DOM then belongs to it and is not rendered again. */
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

  /** Forgets all undo and redo steps. */
  clearHistory() { this.#undo = []; this.#redo = []; this.#group = undefined; this.#before = undefined; }

  get readOnly() { return this.#readOnly; }

  set readOnly(next: boolean) { this.#readOnly = Boolean(next); this.#applyEditable(); }

  /** Known skill names by their lowercase form. */
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

  #applyEditable() {
    if (!this.isConnected) return;
    this.setAttribute("contenteditable", this.#readOnly ? "false" : "plaintext-only");
    this.setAttribute("aria-readonly", String(this.#readOnly));
  }

  #focused() { return document.activeElement === this; }

  #canonical() {
    const plan = fieldSegments(this.#value, this.#skills);
    const nodes = Array.from(this.childNodes).filter(node => !(node instanceof Text) || node.data);
    const filler = this.#value.endsWith("\n") ? 1 : 0;

    if (nodes.length !== plan.length + filler || (filler && nodes.at(-1)?.nodeName !== "BR")) return false;

    return plan.every((segment, index) => {
      const node = nodes[index];

      if ("text" in segment) return node instanceof Text && node.data === segment.text;

      if ("skill" in segment) return isSkillMark(node) && node.childNodes.length === 1 && node.firstChild instanceof Text && node.textContent === segment.skill;

      return linkMarkdown(node) === segment.markdown && node.textContent === segment.label;
    });
  }

  #render() {
    const nodes: Node[] = fieldSegments(this.#value, this.#skills).map(segment => {
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
  }

  /** The offset in `value` of a DOM position inside this field. */
  #offset(node: Node, offset: number) {
    const children = Array.from(this.childNodes);
    const before = (count: number) => children.slice(0, count).reduce((sum, child) => sum + nodeText(child).length, 0);

    if (node === this) return before(offset);
    let top: Node | null = node;

    while (top && top.parentNode !== this) top = top.parentNode;

    if (!top) return this.#value.length;
    const start = before(children.indexOf(top as ChildNode));

    if (node === top && top instanceof Text) return start + offset;

    if (isSkillMark(top) && node !== top) return start + Math.min(offset, nodeText(top).length);

    return start + (node === top && offset === 0 ? 0 : nodeText(top).length);
  }

  /** The DOM position of an offset in `value`. An offset inside a link goes to the end of the link. */
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

  /** Saves the state before a change as an undo step. A change of the same `kind` soon after the last one joins its step. */
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

  #keyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();

    if (key !== "z" && key !== "y") return;
    /* The browser must not undo or redo by itself. Ctrl+Shift+Z does nothing. */
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

      /* A space starts a new word, so it starts a new undo step. */
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

    if (this.#readSelection() && (before.start !== this.#selection.start || before.end !== this.#selection.end)) this.dispatchEvent(new Event("select"));
  };
}

if (!customElements.get(COMPOSER_FIELD_TAG)) customElements.define(COMPOSER_FIELD_TAG, ComposerFieldElement);

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "piop-composer-field": HTMLAttributes<ComposerFieldElement> & { value?: string; skills?: ReadonlyMap<string, string>; readOnly?: boolean; placeholder?: string };
    }
  }
}
