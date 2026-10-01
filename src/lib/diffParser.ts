import type { DiffFile, DiffLine } from './diff';
import { decodeGitPath, displayPath } from './diffPaths';

const MAX_INPUT_CHARS = 4 * 1024 * 1024;

const MAX_LINES = 10_000;

const MAX_LINE_CHARS = 20_000;

export class DiffParser {
  private files: DiffFile[] = [];
  private file?: DiffFile;
  private inHunk = false;
  private oldLine?: number;
  private newLine?: number;
  private renderedLines = 0;
  private gitPaths = false;
  private oldRemaining = 0;
  private newRemaining = 0;
  private codex = false;
  private fallbackPath?: string;

  constructor(fallbackPath?: string) { this.fallbackPath = fallbackPath; }

  private pushLine(line: DiffLine) {
    if (!this.file || this.renderedLines >= MAX_LINES) return;
    this.file.lines.push(line.text.length > MAX_LINE_CHARS ? { ...line, text: `${line.text.slice(0, MAX_LINE_CHARS)}…` } : line);
    this.renderedLines++;
  }

  private startFile(path: string) {
    this.file = { id: `${this.files.length}:${path}`, path, lines: [], additions: 0, deletions: 0 };
    this.files.push(this.file); this.inHunk = false; this.oldLine = undefined; this.newLine = undefined;
  }

  private gitHeader(text: string) {
    if (!text.startsWith('diff --git ')) return false;
    this.startFile(displayPath(text)); this.gitPaths = true; this.codex = false;

    return true;
  }

  private codexHeader(text: string) {
    const operation = /^\*\*\* (Add File|Update File|Delete File): (.+)$/.exec(text);

    if (operation) {
      this.startFile(operation[2]); this.gitPaths = false; this.codex = true;
      this.inHunk = operation[1] === 'Add File'; this.newLine = this.inHunk ? 1 : undefined;
      this.pushLine({ kind: 'meta', text });

      return true;
    }

    if (!this.codex) return false;

    if (text.startsWith('*** Move to: ') && this.file) {
      this.file.oldPath = this.file.path; this.file.path = text.slice(13);
      this.pushLine({ kind: 'meta', text });

      return true;
    }

    if (!text.startsWith('*** ')) return false;
    this.inHunk = false;

    return true;
  }

  private prepareFile(text: string, nextIsNewFile: boolean) {
    const pairedHeader = !this.codex && text.startsWith('--- ') && nextIsNewFile;

    if (pairedHeader && this.finishedHunk()) {
      this.prepareUnifiedFile();
    }

    if (!this.file && this.fallbackPath && this.isFallbackHeader(text)) this.startFile(this.fallbackPath);
  }

  private finishedHunk() { return !this.inHunk || (this.oldRemaining <= 0 && this.newRemaining <= 0); }

  private prepareUnifiedFile() {
    if (!this.file || this.inHunk) { this.startFile(this.fallbackPath ?? ''); this.gitPaths = false; }

    this.inHunk = false;
  }

  private isFallbackHeader(text: string) { return text.startsWith('@@') || /^[ +\-]\s*\d+\s/.test(text); }

  private filePath(text: string) {
    if (this.inHunk || !this.file || !(text.startsWith('+++ ') || text.startsWith('--- '))) return false;
    const path = decodeGitPath(text.slice(4).split('\t')[0]);

    if (path !== '/dev/null') {
      this.file.path = this.gitPaths ? path.replace(/^[ab]\//, '') : path;

      if (text.startsWith('--- ')) this.file.oldPath = this.file.path;
    }

    return true;
  }

  private hunkHeader(text: string) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);

    if (hunk) {
      this.inHunk = true; this.oldLine = Number(hunk[1]); this.newLine = Number(hunk[3]);
      this.oldRemaining = Number(hunk[2] ?? 1); this.newRemaining = Number(hunk[4] ?? 1);
      this.pushLine({ kind: 'meta', text });

      return true;
    }

    if (!this.codex || !text.startsWith('@@')) return false;
    this.inHunk = true; this.oldLine = undefined; this.newLine = undefined;
    this.pushLine({ kind: 'meta', text });

    return true;
  }

  private numberedLine(text: string) {
    const numbered = !this.inHunk && this.fallbackPath ? /^([ +\-])\s*(\d+) (.*)$/.exec(text) : null;

    if (!numbered || !this.file) return false;
    const kind = numbered[1] === '+' ? 'add' : numbered[1] === '-' ? 'delete' : 'context';
    const line: DiffLine = { kind, text: numbered[3] };

    if (kind !== 'add') line.oldLine = Number(numbered[2]);

    if (kind !== 'delete') line.newLine = Number(numbered[2]);
    this.pushLine(line);
    this.countChange(kind);

    return true;
  }

  private countChange(kind: DiffLine['kind']) {
    if (!this.file) return;

    if (kind === 'add') this.file.additions++;

    if (kind === 'delete') this.file.deletions++;
  }

  private changeLine(text: string) {
    if (!this.inHunk || !this.file) return false;

    if (text.startsWith('+')) {
      this.pushLine({ kind: 'add', text: text.slice(1), newLine: this.newLine });
      this.advanceNewLine(); this.file.additions++;

      return true;
    }

    if (text.startsWith('-')) {
      this.pushLine({ kind: 'delete', text: text.slice(1), oldLine: this.oldLine });
      this.advanceOldLine(); this.file.deletions++;

      return true;
    }

    if (!text.startsWith(' ')) return false;
    this.pushLine({ kind: 'context', text: text.slice(1), oldLine: this.oldLine, newLine: this.newLine });
    this.advanceOldLine(); this.advanceNewLine();

    return true;
  }

  private advanceOldLine() { if (this.oldLine !== undefined) this.oldLine++; this.oldRemaining--; }
  private advanceNewLine() { if (this.newLine !== undefined) this.newLine++; this.newRemaining--; }

  private metadata(text: string) {
    if (!this.file) return;

    if (text.startsWith('rename from ')) this.file.oldPath = decodeGitPath(text.slice(12));

    if (text.startsWith('rename to ')) this.file.path = decodeGitPath(text.slice(10));

    if (text && !['index ', '--- ', '+++ '].some(prefix => text.startsWith(prefix))) this.pushLine({ kind: 'meta', text });
  }

  private consume(text: string, nextIsNewFile: boolean) {
    if (this.gitHeader(text) || this.codexHeader(text)) return;
    this.prepareFile(text, nextIsNewFile);

    if (!this.file) return;

    if (this.filePath(text) || this.hunkHeader(text) || this.numberedLine(text) || this.changeLine(text)) return;
    this.metadata(text);
  }

  parse(patch: string) {
    const bounded = patch.slice(0, MAX_INPUT_CHARS);

    for (let start = 0; start < bounded.length;) {
      const newline = bounded.indexOf('\n', start);
      const end = newline < 0 ? bounded.length : newline;
      const text = bounded.slice(start, end);

      if (text) this.consume(text, text.startsWith('--- ') && bounded.startsWith('+++ ', end + 1));
      start = end + 1;

      while (bounded.charCodeAt(start) === 10) start++;
    }

    if (patch.length > bounded.length || this.renderedLines >= MAX_LINES) this.files.at(-1)?.lines.push({ kind: 'meta', text: 'Diff display truncated for performance.' });

    return this.files;
  }
}
