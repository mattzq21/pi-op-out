import type { Marked, Token, TokensList } from "marked";
import { MarkdownLexer } from "../lib/markdownTokenizer";

type Block = { raw: string; type: string; html: string };

type Sanitize = (html: string, streaming: boolean, detectFiles: boolean) => string;

function stableTokenCount(tokens: Token[]) {
  let last = tokens.length - 1;

  while (last >= 0 && tokens[last].type === "space") last--;

  return Math.max(0, last);
}

function needsFullContext(parser: Marked, tokens: TokensList) {
  let html = false;
  parser.walkTokens(tokens, token => { if (token.type === "html") html = true; });

  return html || Object.keys(tokens.links).length > 0;
}

function canReuseSource(source: string, previousSource: string, streaming: boolean, previousStreaming: boolean, detectFiles: boolean, previousDetectFiles: boolean) {
  return source === previousSource && detectFiles === previousDetectFiles && (streaming === previousStreaming || previousStreaming && !streaming);
}

function canAppendSource(streaming: boolean, sameOptions: boolean, source: string, previousSource: string) {
  return streaming && sameOptions && source.startsWith(previousSource);
}

export function streamingMarkdown(parser: Marked, sanitize: Sanitize) {
  let previousSource = "";
  let previousStreaming = false;
  let previousDetectFiles = false;
  let previousLinks = "";
  let previous: Block[] = [];
  let committed: Block[] = [];
  let offset = 0;

  const cachedBlocks = (streaming: boolean) => {
    if (previousStreaming && !streaming) {
      previous = previous.map(block => {
        const html = block.html.replaceAll('data-complete="false"', 'data-complete="true"');

        return html === block.html ? block : { ...block, html };
      });
      committed = []; offset = 0;
    }

    previousStreaming = streaming;

    return previous.map(block => block.html);
  };

  return (input: string, streaming: boolean, detectFiles: boolean) => {
    const source = input.replace(/\r\n?/g, "\n");
    const sameOptions = streaming === previousStreaming && detectFiles === previousDetectFiles;

    if (canReuseSource(source, previousSource, streaming, previousStreaming, detectFiles, previousDetectFiles)) return cachedBlocks(streaming);

    const append = canAppendSource(streaming, sameOptions, source, previousSource);

    if (!append) { committed = []; offset = 0; }

    let tail = source.slice(offset);
    let tokens = new MarkdownLexer(parser.defaults).lex(tail);
    const fullContext = needsFullContext(parser, tokens);

    if (fullContext && offset) {
      committed = []; offset = 0; tail = source;
      tokens = new MarkdownLexer(parser.defaults).lex(source);
    }

    const links = JSON.stringify(tokens.links);
    const reuse = append && links === previousLinks;

    const blocks = tokens.map((token, index): Block => {
      const cached = reuse ? previous[committed.length + index] : undefined;

      if (cached?.raw === token.raw && cached.type === token.type) return cached;

      return { raw: token.raw, type: token.type, html: sanitize(parser.parser([token]), streaming, detectFiles) };
    });

    const next = [...committed, ...blocks];

    if (!fullContext && tokens.map(token => token.raw).join("") === tail) {
      const stable = blocks.slice(0, stableTokenCount(tokens));
      committed = [...committed, ...stable];
      offset += stable.reduce((length, block) => length + block.raw.length, 0);
    }

    previousSource = source;
    previousStreaming = streaming;
    previousDetectFiles = detectFiles;
    previousLinks = links;
    previous = next;

    return next.map(block => block.html);
  };
}
