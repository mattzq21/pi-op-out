import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Type as Schema } from "typebox";
import { Check } from "typebox/value";
import { DEFAULT_VIEWPORT_SIZE, HTML_PREVIEW_MESSAGE, HTML_PREVIEW_VIEWPORT_COMMAND, MAX_TITLE_LENGTH } from "./interface.ts";
import { createHtmlPreview } from "./preview.ts";

const sizeSchema = Schema.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

/** Keeps the last viewport size when Pi reloads extensions in the same process. */
const sizeKey = Symbol.for("piop.html-preview-size");

const viewportSize = (value: unknown) => Check(sizeSchema, value) ? value : DEFAULT_VIEWPORT_SIZE;

export default function htmlPreview(pi: ExtensionAPI) {
  let size = viewportSize(Object.getOwnPropertyDescriptor(globalThis, sizeKey)?.value);

  const defineTool = () => pi.registerTool({
    name: "render_html", label: "Render HTML",
    description: `Display self-contained HTML in the piop chat harness. Use a dark theme only. Supply exactly one of html or path (UTF-8 file on this agent's host, relative to the current working directory or absolute). The current client's desktop preview is a centered ${size}×${size} CSS-pixel viewport. Design the HTML to fit these exact dimensions. Mobile displays only a small placeholder. Inline CSS and JavaScript are supported in an isolated sandbox. Embed assets as data URLs; external resources, network requests, relative file assets, and access to the harness are unavailable. Maximum 512,000 UTF-8 bytes. The HTML is saved as a snapshot in the conversation.`,
    parameters: Type.Object({
      html: Type.Optional(Type.String({ minLength: 1, description: "HTML document or fragment to display." })),
      path: Type.Optional(Type.String({ minLength: 1, description: "Path to a self-contained HTML file on this host." })),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TITLE_LENGTH, description: "Short accessible preview title." })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const details = await createHtmlPreview(params, ctx.cwd, signal);
      pi.sendMessage({ customType: HTML_PREVIEW_MESSAGE, content: details.title, display: true, details }, { triggerTurn: false });

      return { content: [{ type: "text", text: `Displayed ${details.title} in the chat (${size}×${size} on desktop; placeholder on mobile).` }], details: {} };
    },
  });

  defineTool();
  pi.events.on("piop:rpc", request => {
    if (request.command !== HTML_PREVIEW_VIEWPORT_COMMAND) return;
    request.ready = Promise.resolve().then(() => {
      const next = viewportSize((request.payload as { size?: unknown } | undefined)?.size);
      Object.defineProperty(globalThis, sizeKey, { value: next, configurable: true });

      if (next !== size) { size = next; defineTool(); }

      return { width: size, height: size };
    });
  });
}
