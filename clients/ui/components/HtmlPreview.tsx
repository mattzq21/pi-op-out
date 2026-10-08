import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { htmlPreviewSize, isMobile } from "../lib/platform";
import "./html-preview.css";

const previewSchema = z.object({ version: z.literal(1), html: z.string().min(1).max(512_000), title: z.string().min(1).max(120) });

const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function isolatedDocument(html: string) {
  const content = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;min-height:100%;}body{background:white;color:black;}</style></head><body>${html}</body></html>`;
  const source = content.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;}iframe{display:block;width:100%;height:100%;border:0;}</style></head><body><iframe title="HTML preview content" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${source}"></iframe></body></html>`;
}

export function HtmlPreview(props: { details: unknown }) {
  const [size, setSize] = createSignal(htmlPreviewSize());
  onMount(() => {
    const updateSize = () => setSize(htmlPreviewSize());
    updateSize();
    window.addEventListener("resize", updateSize);
    window.addEventListener("focus", updateSize);
    onCleanup(() => {
      window.removeEventListener("resize", updateSize);
      window.removeEventListener("focus", updateSize);
    });
  });
  const preview = createMemo(() => previewSchema.safeParse(props.details));

  const value = () => { const result = preview();

  return result.success ? result.data : undefined; };

  const document = createMemo(() => {
    const preview = value();

    if (isMobile || !preview) return undefined;

    return isolatedDocument(preview.html);
  });

  return <Show when={value()} fallback={<p class="html-preview-error" role="status">HTML preview is unavailable.</p>}>{preview =>
    <Show when={!isMobile} fallback={<div class="html-preview-placeholder" role="img" aria-label={`${preview().title}; available on desktop`}><strong>{preview().title}</strong><span>HTML preview · View on desktop</span></div>}>
      <div class="html-preview" style={{ "--html-preview-size": `${size()}px` }} role="region" aria-label={preview().title} tabindex="0">
        <iframe class="html-preview-frame" title={preview().title} width={size()} height={size()} sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc={document()} />
      </div>
    </Show>
  }</Show>;
}
