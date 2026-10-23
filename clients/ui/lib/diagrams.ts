import { required } from "./required";
import DOMPurify from "dompurify";

let renderer: Promise<typeof import("mermaid")> | undefined;

let queue = Promise.resolve();

let sequence = 0;

const cache = new Map<string, string>();

const MAX_CACHE_CHARACTERS = 3_200_000;

let cacheCharacters = 0;

function cacheDiagram(key: string, svg: string) {
  const characters = key.length + svg.length;

  if (characters > MAX_CACHE_CHARACTERS) return;

  while (cache.size >= 16 || cacheCharacters + characters > MAX_CACHE_CHARACTERS) {
    const oldest = required(cache.keys().next().value);
    cacheCharacters -= oldest.length + required(cache.get(oldest)).length;
    cache.delete(oldest);
  }

  cache.set(key, svg);
  cacheCharacters += characters;
}

function cleanSvg(svg: string) {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "image", "a", "script"],
    FORBID_ATTR: ["href", "xlink:href", "tabindex"],
  });

  return clean.replace(/url\(([^)]*)\)/gi, (match, target: string) => /^['"]?#[\w-]+['"]?$/.test(target.trim()) ? match : "none").replace(/@import[^;]*;/gi, "");
}

function instanceSvg(svg: string) {
  const prefix = `piop-svg-${++sequence}-`;
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const names = new Map(ids.map((id, index) => [id, `${prefix}${index}`]));
  const alternatives = ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  if (!alternatives) return svg;

  return svg.replace(new RegExp(`#(${alternatives})(?![\\w-])`, "g"), (_match, id: string) => `#${names.get(id)}`)
    .replace(/\sid="([^"]+)"/g, (_match, id: string) => ` id="${names.get(id)}"`)
    .replace(/(aria-labelledby|aria-describedby)="([^"]*)"/g, (_match, attribute: string, value: string) => `${attribute}="${value.split(/\s+/).map(id => names.get(id) ?? id).join(" ")}"`);
}

async function render(source: string) {
  if (source.length > 30_000) throw new Error("Diagram is too large (maximum 30,000 characters).");

  if (/%%\s*\{|^\s*---/.test(source)) throw new Error("Remove Mermaid configuration directives or frontmatter; piop manages diagram styling.");
  renderer ??= import("mermaid").catch(error => { renderer = undefined; throw error; });
  const { default: mermaid } = await renderer;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "dark",
    fontFamily: "Arial, sans-serif",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: 30_000,
    maxEdges: 300,
  });
  const id = `piop-diagram-${++sequence}`;

  try { return cleanSvg((await mermaid.render(id, source)).svg); }
  finally { document.getElementById(`d${id}`)?.remove(); }
}

export function renderDiagram(source: string, current: () => boolean): Promise<string | undefined> {
  const result = queue.then(async () => {
    if (!current()) return;
    const cached = cache.get(source);

    if (cached) return instanceSvg(cached);
    const svg = await render(source);
    cacheDiagram(source, svg);

    return instanceSvg(svg);
  });

  queue = result.then(() => undefined, () => undefined);

  return result;
}

export function diagramFenceClosed(raw: string) {
  const lines = raw.trimEnd().split("\n");
  const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[0]);

  if (!opening || lines.length < 2) return false;

  return new RegExp(`^\\s{0,3}${opening[1][0]}{${opening[1].length},}\\s*$`).test(required(lines.at(-1)));
}
