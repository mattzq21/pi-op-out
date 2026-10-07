import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import { BulletWidget, TaskWidget } from "./markdownWidgets";

const inlineStyles = new Map([
  ["StrongEmphasis", "notes-strong"], ["Emphasis", "notes-emphasis"], ["Strikethrough", "notes-strikethrough"],
  ["InlineCode", "notes-inline-code"], ["Link", "notes-link"],
]);

const hiddenMarks = new Set(["HeaderMark", "EmphasisMark", "StrikethroughMark", "CodeMark", "QuoteMark", "LinkMark"]);

function editingLine(view: EditorView, from: number, to: number) {
  if (!view.hasFocus || view.state.readOnly) return false;

  return view.state.selection.ranges.some(range => {
    const first = view.state.doc.lineAt(range.from).from;
    const last = view.state.doc.lineAt(range.to).to;

    return first <= to && last >= from;
  });
}

function decorateLines(view: EditorView, ranges: Range<Decoration>[], from: number, to: number, className: string) {
  for (const viewport of view.visibleRanges) {
    const start = Math.max(from, viewport.from);
    const end = Math.min(to, viewport.to);

    if (start > end) continue;

    for (let number = view.state.doc.lineAt(start).number; number <= view.state.doc.lineAt(end).number; number++) {
      ranges.push(Decoration.line({ class: className }).range(view.state.doc.line(number).from));
    }
  }
}

function decorateNode(view: EditorView, ranges: Range<Decoration>[], node: SyntaxNodeRef) {
  const name = node.name;
  const style = inlineStyles.get(name);

  if (style) ranges.push(Decoration.mark({ class: style }).range(node.from, node.to));
  const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);

  if (heading) ranges.push(Decoration.line({ class: `notes-heading notes-heading-${heading[1]}` }).range(view.state.doc.lineAt(node.from).from));

  if (name === "FencedCode" || name === "CodeBlock") decorateLines(view, ranges, node.from, node.to, "notes-code-line");

  if (name === "Blockquote") decorateLines(view, ranges, node.from, node.to, "notes-quote-line");

  decorateMarker(view, ranges, node);
}

function decorateMarker(view: EditorView, ranges: Range<Decoration>[], node: SyntaxNodeRef) {
  if (editingLine(view, node.from, node.to)) return;

  if (hiddenMarks.has(node.name)) ranges.push(Decoration.replace({}).range(node.from, node.to));

  if (node.name === "TaskMarker") {
    const checked = view.state.doc.sliceString(node.from, node.to).toLowerCase() === "[x]";
    ranges.push(Decoration.replace({ widget: new TaskWidget(checked, node.from, node.to, view.state.readOnly) }).range(node.from, node.to));
  }

  if (node.name === "ListMark" && /^[-+*]$/.test(view.state.doc.sliceString(node.from, node.to))) {
    ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
  }

  if (node.name === "URL" && isLinkDestination(view, node)) ranges.push(Decoration.replace({}).range(node.from, node.to));
}

function isLinkDestination(view: EditorView, node: SyntaxNodeRef) {
  const marker = node.node.prevSibling;

  if (!marker || node.node.parent?.name !== "Link") return false;

  return marker.name === "LinkMark" && view.state.doc.sliceString(marker.from, marker.to) === "(";
}

function decorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);

  for (const viewport of view.visibleRanges) {
    tree.iterate({ from: viewport.from, to: viewport.to, enter: node => decorateNode(view, ranges, node) });
  }

  return Decoration.set(ranges, true);
}

export const liveMarkdown = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) { this.decorations = decorations(view); }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || update.startState.readOnly !== update.state.readOnly || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = decorations(update.view);
    }
  }
}, { decorations: value => value.decorations });
