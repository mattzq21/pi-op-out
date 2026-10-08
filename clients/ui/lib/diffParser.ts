import type { DiffFile, DiffLine } from './diff';
import { decodeGitPath, displayPath } from './diffPaths';
import { diffBytes, isDiffAsset, MAX_DIFF_FILE_BYTES, MAX_DIFF_FILE_LINES, MAX_DIFF_PREVIEW_BYTES, MAX_DIFF_PREVIEW_LINES } from './diffPolicy';

const MAX_LINE_CHARS = 20_000;

export class DiffParser {
  private files: DiffFile[] = [];
  private file?: DiffFile;
  private inHunk = false;
  private oldLine?: number;
  private newLine?: number;
  private previewLines = 0;
  private previewBytes = 0;
  private fileBytes = 0;
  private fileLines = 0;
  private gitPaths = false;
  private oldRemaining = 0;
  private newRemaining = 0;
  private codex = false;
  private fallbackPath?: string;

  constructor(fallbackPath?: string) { this.fallbackPath = fallbackPath; }

  private pushLine(line: DiffLine) {
    if (!this.file || this.file.omitted) return;

    if (line.kind !== 'meta') {
      this.fileLines++; this.previewLines++; this.previewBytes += diffBytes(line.text);

      if (this.fileLines > MAX_DIFF_FILE_LINES) this.omit('large');

      if (this.previewLines > MAX_DIFF_PREVIEW_LINES || this.previewBytes > MAX_DIFF_PREVIEW_BYTES || line.text.length > MAX_LINE_CHARS) {
        this.file.previewOmitted = true; this.file.lines = [];
      }
    }

    if (!this.file.previewOmitted && !this.file.omitted) this.file.lines.push(line);
  }

  private omit(reason: 'binary' | 'large') {
    if (!this.file) return;

    this.file.omitted = reason; this.file.previewOmitted = true;
    this.file.lines = []; this.file.additions = 0; this.file.deletions = 0;
  }

  private finishFile() {
    if (!this.file) return;

    if (isDiffAsset(this.file.path)) this.omit('binary');

    if (this.file.status === 'modified' && this.file.oldPath && this.file.oldPath !== this.file.path) this.file.status = 'renamed';
  }

  private startFile(path: string) {
    this.finishFile();
    this.file = { id: `${this.files.length}:${path}`, path, status: 'modified', lines: [], additions: 0, deletions: 0 };
    this.files.push(this.file); this.inHunk = false; this.oldLine = undefined; this.newLine = undefined;
    this.previewLines = 0; this.previewBytes = 0; this.fileBytes = 0; this.fileLines = 0;

    if (isDiffAsset(path)) this.omit('binary');
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

      if (this.file) this.file.status = operation[1] === 'Add File' ? 'added' : operation[1] === 'Delete File' ? 'deleted' : 'modified';

      this.inHunk = operation[1] === 'Add File'; this.newLine = this.inHunk ? 1 : undefined;
      this.pushLine({ kind: 'meta', text });

      return true;
    }

    if (!this.codex) return false;

    if (text.startsWith('*** Move to: ') && this.file) {
      this.file.oldPath = this.file.path; this.file.path = text.slice(13);
      this.file.status = 'renamed';
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

    if (path === '/dev/null') this.file.status = text.startsWith('--- ') ? 'added' : 'deleted';

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
    if (!this.file || this.file.omitted) return;

    if (kind === 'add') this.file.additions++;

    if (kind === 'delete') this.file.deletions++;
  }

  private changeLine(text: string) {
    if (!this.inHunk || !this.file) return false;

    if (text.startsWith('+')) {
      this.pushLine({ kind: 'add', text: text.slice(1), newLine: this.newLine });
      this.advanceNewLine(); this.countChange('add');

      return true;
    }

    if (text.startsWith('-')) {
      this.pushLine({ kind: 'delete', text: text.slice(1), oldLine: this.oldLine });
      this.advanceOldLine(); this.countChange('delete');

      return true;
    }

    if (!text.startsWith(' ')) return false;
    this.pushLine({ kind: 'context', text: text.slice(1), oldLine: this.oldLine, newLine: this.newLine });
    this.advanceOldLine(); this.advanceNewLine();

    return true;
  }

  private advanceOldLine() { if (this.oldLine !== undefined) this.oldLine++; this.oldRemaining--; }
  private advanceNewLine() { if (this.newLine !== undefined) this.newLine++; this.newRemaining--; }

  private operationMetadata(text: string) {
    if (!this.file) return;

    if (text.startsWith('new file mode ')) this.file.status = 'added';

    if (text.startsWith('deleted file mode ')) this.file.status = 'deleted';

    if (/^(?:Binary files |GIT binary patch$|piop diff omitted: binary$)/.test(text)) this.omit('binary');

    if (text === 'piop diff omitted: large') this.omit('large');
  }

  private metadata(text: string) {
    if (!this.file) return;
    this.operationMetadata(text);

    if (text.startsWith('rename from ')) this.file.oldPath = decodeGitPath(text.slice(12));

    if (text.startsWith('rename to ')) this.file.path = decodeGitPath(text.slice(10));

    if (text && !['index ', '--- ', '+++ '].some(prefix => text.startsWith(prefix))) this.pushLine({ kind: 'meta', text });
  }

  private consume(text: string, nextIsNewFile: boolean) {
    if (this.gitHeader(text) || this.codexHeader(text)) return;
    this.prepareFile(text, nextIsNewFile);

    if (!this.file) return;
    this.fileBytes += text.length > MAX_DIFF_FILE_BYTES ? MAX_DIFF_FILE_BYTES + 1 : diffBytes(text) + 1;

    if (this.fileBytes > MAX_DIFF_FILE_BYTES) this.omit('large');

    if (this.filePath(text) || this.hunkHeader(text) || this.numberedLine(text) || this.changeLine(text)) return;
    this.metadata(text);
  }

  parse(patch: string) {
    for (let start = 0; start < patch.length;) {
      const newline = patch.indexOf('\n', start);
      const end = newline < 0 ? patch.length : newline;
      const text = patch.slice(start, end);

      if (text) this.consume(text, text.startsWith('--- ') && patch.startsWith('+++ ', end + 1));
      start = end + 1;

      while (patch.charCodeAt(start) === 10) start++;
    }

    this.finishFile();

    return this.files;
  }
}
