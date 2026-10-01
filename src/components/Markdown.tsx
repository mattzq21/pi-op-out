import { required } from "../lib/required";
import DOMPurify from "dompurify";
import { Copy } from "lucide-solid";
import { Marked } from "marked";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { openExternalUrl } from "../lib/nativeTransport";
import { fileReference, type FileReference } from "../lib/projectFiles";
import { detectFileLinks } from "../lib/fileLinks";
import { webUrl } from "../lib/webLinks";
import { diagramFenceClosed } from "../lib/diagrams";
import { markdownBlocks } from "./markdownBlocks";
import { streamingMarkdown } from "./streamingMarkdown";
import { markdownHooks, markdownTokenizer } from "../lib/markdownTokenizer";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => required(({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]));

const parser = new Marked({
  gfm: true,
  tokenizer: markdownTokenizer,
  hooks: markdownHooks,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => `<span class="message-image-placeholder" role="img" aria-label="${escapeHtml(text || "Blocked remote image")}">[Image: ${escapeHtml(text || "blocked")}]</span>`,
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = webUrl(href);

      return url ? `<a class="message-link" href="${escapeHtml(url)}" title="Click to open in browser&#10;${escapeHtml(url)}">${text}</a>` : `<span class="message-link"${fileReference(href) ? ` data-file-reference="${escapeHtml(href)}"` : ""} title="${escapeHtml(href)}">${text}</span>`;
    },
    code({ text, lang, raw }) {
      const language = lang?.split(/\s/)[0];

      if (language?.toLowerCase() === "mermaid") return `<div class="diagram-placeholder" data-complete="${diagramFenceClosed(raw)}"><pre><code>${escapeHtml(text)}</code></pre></div>`;

      return `<div class="code-block"><pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(text)}\n</code></pre><button type="button" class="icon-button code-copy" aria-label="Copy code" title="Copy code">⧉</button></div>`;
    },
  },
});

let purifier: ReturnType<typeof DOMPurify> | undefined;

let purifierWindow: Window | undefined;

export function markdownHtml(source: string, streaming = false, detectFiles = false) {
  try { return sanitizeMarkdown(parser.parse(source, { async: false }), streaming, detectFiles); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;

    return `<pre>${escapeHtml(source)}</pre>`;
  }
}

function sanitizeMarkdown(html: string, streaming: boolean, detectFiles: boolean) {
  if (!purifier || purifierWindow !== window) { purifier = DOMPurify(window); purifierWindow = window; }

  const sanitized = purifier.sanitize(streaming ? html : html.replaceAll('data-complete="false"', 'data-complete="true"'), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "video", "audio", "source", "iframe", "form", "style"],
    FORBID_ATTR: ["style", "src", "srcset", "id", "name"],
    RETURN_DOM_FRAGMENT: true,
  });

  if (detectFiles) return detectFileLinks(sanitized);
  const template = document.createElement("template");
  template.content.append(sanitized);

  return template.innerHTML;
}

type LinkMenu = { href: string; x: number; y: number; returnFocus?: HTMLElement };

export function Markdown(props: { children: string; streaming?: boolean; onOpenFile?: (file: FileReference) => void }) {
  const renderMarkdown = streamingMarkdown(parser, sanitizeMarkdown);
  const [error, setError] = createSignal<string>();
  const [menu, setMenu] = createSignal<LinkMenu>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let root: HTMLDivElement | undefined;
  const blocks = markdownBlocks();
  createEffect(() => {
    let html: string[];

    try { html = renderMarkdown(props.children, Boolean(props.streaming), Boolean(props.onOpenFile)); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      html = [`<pre>${escapeHtml(props.children)}</pre>`];
    }

    if (root) blocks.update(root, html);
  });
  onCleanup(() => blocks.dispose());
  const [menuElement, setMenuElement] = createSignal<HTMLDivElement>();
  onCleanup(() => timers.forEach(clearTimeout));
  const close = (restoreFocus = false) => { if (restoreFocus) menu()?.returnFocus?.focus({ preventScroll: true }); setMenu(undefined); };

  createEffect(() => {
    const current = menu();
    const element = menuElement();

    if (!current || !element) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(current.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(current.y, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector("button")?.focus({ preventScroll: true });
    const outside = (event: Event) => { if (event.target instanceof Node && !element.contains(event.target)) close(); };

    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }

      close(true); }
      else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) event.preventDefault();
    };

    const dismiss = () => close();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("contextmenu", outside, true);
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    onCleanup(() => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    });
  });

  const copyCode = async (button: HTMLButtonElement) => {
    button.closest(".code-block")?.querySelector("[role=status]")?.remove();

    try {
      await navigator.clipboard.writeText((button.closest(".code-block")?.querySelector("code")?.textContent ?? "").replace(/\n$/, ""));
      button.textContent = "✓"; button.setAttribute("aria-label", "Code copied");
    } catch {
      button.textContent = "!"; button.setAttribute("aria-label", "Copy failed");
      const feedback = document.createElement("span");
      feedback.className = "copy-feedback"; feedback.setAttribute("role", "status"); feedback.textContent = "Could not copy";
      button.closest(".code-block")?.append(feedback);
    }

    const timer = setTimeout(() => { button.textContent = "⧉"; button.setAttribute("aria-label", "Copy code"); button.closest(".code-block")?.querySelector("[role=status]")?.remove(); timers.delete(timer); }, 1800);
    timers.add(timer);
  };

  const openFileLink = (link: HTMLButtonElement) => {
    const reference = fileReference(link.dataset.fileReference ?? "");

    if (reference) props.onOpenFile?.(reference);
  };

  const click = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const fileLink = event.target.closest<HTMLButtonElement>("button.file-link");

    if (fileLink) {
      event.preventDefault();
      openFileLink(fileLink);

      return;
    }

    const link = event.target.closest<HTMLAnchorElement>("a");

    if (link) {
      event.preventDefault();
      const url = webUrl(link.href);

      if (event.button === 0 && url) { setError(undefined); void openExternalUrl(url).catch(reason => setError(`Could not open link: ${reason instanceof Error ? reason.message : String(reason)}`)); }
    }

    const button = event.target.closest<HTMLButtonElement>("button.code-copy");

    if (button) void copyCode(button);
  };

  const contextMenu = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a") : null;

    if (!link) return;
    const href = webUrl(link.href);

    if (!href) return;
    event.preventDefault();
    const bounds = link.getBoundingClientRect();
    setMenu({ href, x: event.clientX || bounds.left, y: event.clientY || bounds.bottom, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : link });
  };

  const copyLink = async () => { const capturedMenu = menu();
    const current = capturedMenu;

    if (!current) return;
    setError(undefined);

    try { await navigator.clipboard.writeText(current.href); } catch { setError("Could not copy link"); }

    close(true);
  };

  return <>
    <div ref={root} class="markdown-content" onClick={click} onContextMenu={contextMenu} onAuxClick={event => event.preventDefault()} />
    <Show when={menu()}>{current => <Portal mount={root?.closest(".app") ?? document.body}>
      <div ref={setMenuElement} class="conversation-menu link-context-menu" role="menu" aria-label="Link actions" style={{ left: `${current().x}px`, top: `${current().y}px` }} onContextMenu={event => event.preventDefault()}>
        <button type="button" role="menuitem" onClick={() => void copyLink()}><Copy size={14} />Copy link</button>
      </div>
    </Portal>}</Show>
    <Show when={error()}><span class="message-link-error" role="alert">{error()}</span></Show>
  </>;
}
