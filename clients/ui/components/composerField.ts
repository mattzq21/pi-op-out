import { sessionReference } from "../lib/sessionDrop";

/**
 * The message box of the composer. It works like a textarea: `value`, `selectionStart`, `selectionEnd`, `setSelectionRange`,
 * `readOnly`, `placeholder`, and "input" and "select" events. All offsets are offsets in `value`, the Markdown text.
 * Links to chats show as links. Each link is one unit: the caret goes before or after it, never into it.
 */
export const COMPOSER_FIELD_TAG = "piop-composer-field";

const SESSION_LINK = /\[((?:\\.|[^\\\]\n])*)\]\((piop:\/\/session\/[^/()\s]+\/[^/()\s]+)\)/g;

type Segment = { text: string } | { markdown: string; label: string };

function segments(value: string): Segment[] {
  const result: Segment[] = [];
  let last = 0;

  for (const match of value.matchAll(SESSION_LINK)) {
    if (!sessionReference(match[2])) continue;

    if (match.index > last) result.push({ text: value.slice(last, match.index) });
    result.push({ markdown: match[0], label: match[1].replace(/\\(.)/g, "$1") });
    last = match.index + match[0].length;
  }

  if (last < value.length) result.push({ text: value.slice(last) });

  return result;
}

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

export class ComposerFieldElement extends HTMLElement {
  #value = "";
  #selection = { start: 0, end: 0 };
  #readOnly = false;
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
  }

  connectedCallback() {
    this.setAttribute("role", "textbox");
    this.setAttribute("aria-multiline", "true");

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
    this.#value = next;
    this.#render();
    this.#selection = { start: Math.min(this.#selection.start, next.length), end: Math.min(this.#selection.end, next.length) };

    if (focused) this.#applySelection();
  }

  get readOnly() { return this.#readOnly; }

  set readOnly(next: boolean) { this.#readOnly = Boolean(next); this.#applyEditable(); }

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
    const plan = segments(this.#value);
    const nodes = Array.from(this.childNodes).filter(node => !(node instanceof Text) || node.data);
    const filler = this.#value.endsWith("\n") ? 1 : 0;

    if (nodes.length !== plan.length + filler || (filler && nodes.at(-1)?.nodeName !== "BR")) return false;

    return plan.every((segment, index) => {
      const node = nodes[index];

      return "text" in segment ? node instanceof Text && node.data === segment.text : linkMarkdown(node) === segment.markdown && node.textContent === segment.label;
    });
  }

  #render() {
    const nodes: Node[] = segments(this.#value).map(segment => {
      if ("text" in segment) return document.createTextNode(segment.text);
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

  #replaceSelection(text: string, inputType: string) {
    this.#readSelection();
    const { start, end } = this.#selection;
    this.#value = this.#value.slice(0, start) + text + this.#value.slice(end);
    this.#render();
    this.#selection = { start: start + text.length, end: start + text.length };
    this.#applySelection();
    this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text || null }));
  }

  #beforeInput = (event: InputEvent) => {
    if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return;
    event.preventDefault();

    if (!this.#readOnly && !this.#composing && !event.isComposing) this.#replaceSelection("\n", "insertLineBreak");
  };

  #input = (event: Event) => {
    this.#readSelection();
    this.#value = nodeText(this);

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
      "piop-composer-field": HTMLAttributes<ComposerFieldElement> & { value?: string; readOnly?: boolean; placeholder?: string };
    }
  }
}
