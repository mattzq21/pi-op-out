import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";

const inlineStyles: Record<string, string> = {
  StrongEmphasis: "notes-strong", Emphasis: "notes-emphasis", Strikethrough: "notes-strikethrough",
  InlineCode: "notes-inline-code", Link: "notes-link",
};
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
  const end = view.state.doc.lineAt(to).number;

  for (let number = view.state.doc.lineAt(from).number; number <= end; number++) {
    ranges.push(Decoration.line({ class: className }).range(view.state.doc.line(number).from));
  }
}

function decorateNode(view: EditorView, ranges: Range<Decoration>[], node: SyntaxNodeRef) {
  const name = node.name;
  const style = inlineStyles[name];

  if (style) ranges.push(Decoration.mark({ class: style }).range(node.from, node.to));
  const heading = /^ATXHeading([1-6])$/.exec(name);

  if (heading) ranges.push(Decoration.line({ class: `notes-heading notes-heading-${heading[1]}` }).range(view.state.doc.lineAt(node.from).from));

  if (name === "FencedCode" || name === "CodeBlock") decorateLines(view, ranges, node.from, node.to, "notes-code-line");

  if (name === "Blockquote") decorateLines(view, ranges, node.from, node.to, "notes-quote-line");

  if (editingLine(view, node.from, node.to)) return;

  if (hiddenMarks.has(name)) ranges.push(Decoration.replace({}).range(node.from, node.to));

  if (name === "URL" && node.node.parent?.name === "Link") ranges.push(Decoration.replace({}).range(node.from, node.to));
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
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = decorations(update.view);
    }
  }
}, { decorations: value => value.decorations });
