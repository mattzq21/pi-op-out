/** Custom message type of a saved preview. Clients render messages of this type. */
export const HTML_PREVIEW_MESSAGE = "piop-html-preview";

/** App request that sets the square viewport size, in CSS pixels, of the client that the agent designs for. */
export const HTML_PREVIEW_VIEWPORT_COMMAND = "html_preview_viewport";

export const MAX_HTML_BYTES = 512_000;

export const MAX_TITLE_LENGTH = 120;

export const DEFAULT_VIEWPORT_SIZE = 600;

/** Details of a HTML_PREVIEW_MESSAGE message. The message content is the title. */
export type HtmlPreviewDetails = { version: 1; html: string; title: string };

/** Payload of HTML_PREVIEW_VIEWPORT_COMMAND. A size that is not a positive whole number selects DEFAULT_VIEWPORT_SIZE. */
export type HtmlPreviewViewportPayload = { size: number };
