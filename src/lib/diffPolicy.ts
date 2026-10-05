import { displayPath } from './diffPaths';

export const MAX_DIFF_PREVIEW_LINES = 1_000;

export const MAX_DIFF_PREVIEW_BYTES = 128 * 1024;

export const MAX_DIFF_FILE_LINES = 25_000;

export const MAX_DIFF_FILE_BYTES = 512 * 1024;

const MAX_RETAINED_PATCH_BYTES = 2 * 1024 * 1024;

const MAX_PATCH_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();

export const diffBytes = (text: string) => encoder.encode(text).length;

export const isDiffAsset = (path: string) => /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic|psd|pdf|woff2?|ttf|otf|eot|mp[34]|m4[av]|wav|ogg|flac|aac|mov|avi|webm|mkv|zip|gz|bz2|xz|7z|rar|tar|exe|dll|so|dylib|wasm|class|jar|pyc|sqlite3?|db)$/i.test(path);

type FilterFile = { header: string; metadata: string[]; body: string[]; bytes: number; rows: number; inHunk: boolean; omitted?: 'binary' | 'large' };

export class GitDiffFilter {
  private files: FilterFile[] = [];
  private file?: FilterFile;
  private pending = '';
  private skippingLine = false;
  private retainedBytes = 0;

  private omit(reason: 'binary' | 'large') {
    if (!this.file) return;

    if (this.file.omitted !== 'binary') this.file.omitted = reason;
    this.file.body = [];
  }

  private finishFile() {
    if (!this.file || this.file.omitted) return;

    if (this.retainedBytes + this.file.bytes > MAX_RETAINED_PATCH_BYTES) this.omit('large');
    else this.retainedBytes += this.file.bytes;
  }

  private consume(line: string) {
    if (line.startsWith('diff --git ')) {
      this.finishFile();
      this.file = { header: line, metadata: [], body: [], bytes: 0, rows: 0, inHunk: false };
      this.files.push(this.file);

      if (isDiffAsset(displayPath(line))) this.omit('binary');

      return;
    }

    if (!this.file) return;
    this.metadata(line);

    if (this.file.omitted) return;
    this.appendLine(line);
  }

  private metadata(line: string) {
    if (!this.file) return;

    if (/^(?:new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to )/.test(line)) this.file.metadata.push(line);

    if (/^(?:Binary files |GIT binary patch$|piop diff omitted: binary$)/.test(line)) this.omit('binary');

    if (line === 'piop diff omitted: large') this.omit('large');
  }

  private appendLine(line: string) {
    if (!this.file) return;
    this.file.bytes += diffBytes(line) + 1;

    if (line.startsWith('@@ ')) this.file.inHunk = true;

    if (this.file.inHunk && /^[ +\-]/.test(line)) this.file.rows++;

    if (this.file.bytes > MAX_DIFF_FILE_BYTES || this.file.rows > MAX_DIFF_FILE_LINES) this.omit('large');
    else this.file.body.push(line);
  }

  write(chunk: string) {
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf('\n', start);
      const end = newline < 0 ? chunk.length : newline;

      if (!this.skippingLine) {
        const part = chunk.slice(start, end);

        if (this.pending.length + part.length > MAX_DIFF_FILE_BYTES) { this.omit('large'); this.pending = ''; this.skippingLine = true; }
        else this.pending += part;
      }

      if (newline < 0) return;

      if (!this.skippingLine) this.consume(this.pending);
      this.pending = ''; this.skippingLine = false; start = end + 1;
    }
  }

  finish() {
    if (this.pending && !this.skippingLine) this.consume(this.pending);
    this.finishFile();

    const render = (metadataOnly: boolean) => this.files.map(file => {
      const omitted = file.omitted ?? (metadataOnly ? 'large' : undefined);

      return [file.header, ...(omitted ? [...file.metadata, `piop diff omitted: ${omitted}`] : file.body)].join('\n') + '\n';
    }).join('');

    const patch = render(false);

    if (diffBytes(patch) <= MAX_PATCH_BYTES) return patch;
    const metadata = render(true);

    if (diffBytes(metadata) > MAX_PATCH_BYTES) throw new Error('Changed file names exceed the diff limit');

    return metadata;
  }
}
