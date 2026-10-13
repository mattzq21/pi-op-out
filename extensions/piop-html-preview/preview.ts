import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_HTML_BYTES, type HtmlPreviewDetails } from "./interface.ts";

/** Tool input. Exactly one of html or path. A relative path starts at cwd. */
export type HtmlPreviewSource = { html?: string; path?: string; title?: string };

const tooLarge = () => new Error("HTML must be at most 512,000 bytes.");

async function readHtml(path: string, cwd: string, signal?: AbortSignal) {
  const file = await open(resolve(cwd, path), "r");

  try {
    const stat = await file.stat();

    if (!stat.isFile()) throw new Error("HTML path must refer to a regular file.");

    if (stat.size > MAX_HTML_BYTES) throw tooLarge();
    const buffer = Buffer.alloc(MAX_HTML_BYTES + 1);
    let length = 0;

    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);

      if (!bytesRead) break;
      length += bytesRead;
    }

    if (length > MAX_HTML_BYTES) throw tooLarge();

    return buffer.subarray(0, length).toString("utf8");
  } finally { await file.close(); }
}

/** Checks the source, reads the file if given, and returns the preview to save. Throws with a user-facing message on invalid input. */
export async function createHtmlPreview(source: HtmlPreviewSource, cwd: string, signal?: AbortSignal): Promise<HtmlPreviewDetails> {
  signal?.throwIfAborted();

  if ((source.html === undefined) === (source.path === undefined)) throw new Error("Supply exactly one of html or path.");

  if (source.path !== undefined && !source.path.trim()) throw new Error("HTML path cannot be empty.");
  const html = source.html ?? await readHtml(source.path ?? "", cwd, signal);

  if (!html.trim()) throw new Error("HTML cannot be empty.");

  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw tooLarge();
  signal?.throwIfAborted();

  return { version: 1, html, title: source.title?.trim() || "HTML preview" };
}
