import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_HTML_BYTES = 512_000;

interface RequiredToolsRequest { ctx: ExtensionContext; tools: string[] }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:required-tools", handler: (request: RequiredToolsRequest) => void): () => void;
    emit(channel: "piop:required-tools", request: RequiredToolsRequest): void;
  }
}

async function readHtml(path: string, cwd: string, signal?: AbortSignal) {
  const file = await open(resolve(cwd, path), "r");

  try {
    const stat = await file.stat();

    if (!stat.isFile()) throw new Error("HTML path must refer to a regular file.");

    if (stat.size > MAX_HTML_BYTES) throw new Error("HTML must be at most 512,000 bytes.");
    const buffer = Buffer.alloc(MAX_HTML_BYTES + 1);
    let length = 0;

    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);

      if (!bytesRead) break;
      length += bytesRead;
    }

    if (length > MAX_HTML_BYTES) throw new Error("HTML must be at most 512,000 bytes.");

    return buffer.subarray(0, length).toString("utf8");
  } finally { await file.close(); }
}

async function previewHtml(params: { html?: string; path?: string }, cwd: string, signal?: AbortSignal) {
  if ((params.html === undefined) === (params.path === undefined)) throw new Error("Supply exactly one of html or path.");

  if (params.path !== undefined && !params.path.trim()) throw new Error("HTML path cannot be empty.");
  const html = params.html ?? await readHtml(params.path ?? "", cwd, signal);

  if (!html.trim()) throw new Error("HTML cannot be empty.");

  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw new Error("HTML must be at most 512,000 bytes.");

  return html;
}

export function registerHtmlPreview(pi: ExtensionAPI) {
  const stop = pi.events.on("piop:required-tools", request => { request.tools.push("render_html"); });
  pi.on("session_shutdown", stop);
  pi.registerTool({
    name: "render_html", label: "Render HTML",
    description: "Display self-contained HTML in the piop chat harness. Supply exactly one of html or path (UTF-8 file on this agent's host, relative to the current working directory or absolute). Desktop displays a fixed 720×720 CSS-pixel viewport; mobile displays only a small placeholder. Inline CSS and JavaScript are supported in an isolated sandbox. Embed assets as data URLs; external resources, network requests, relative file assets, and access to the harness are unavailable. Maximum 512,000 UTF-8 bytes. The HTML is saved as a snapshot in the conversation.",
    parameters: Type.Object({
      html: Type.Optional(Type.String({ minLength: 1, description: "HTML document or fragment to display." })),
      path: Type.Optional(Type.String({ minLength: 1, description: "Path to a self-contained HTML file on this host." })),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Short accessible preview title." })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const html = await previewHtml(params, ctx.cwd, signal);
      signal?.throwIfAborted();
      const title = params.title?.trim() || "HTML preview";
      pi.sendMessage({ customType: "piop-html-preview", content: title, display: true, details: { version: 1, html, title } }, { triggerTurn: false });

      return { content: [{ type: "text", text: `Displayed ${title} in the chat (720×720 on desktop; placeholder on mobile).` }], details: {} };
    },
  });
}
