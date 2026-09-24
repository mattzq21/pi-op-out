import { fileReference, looksLikeFile } from "./projectFiles";
import { webUrl } from "./webLinks";

function fileButton(path: string, label: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "file-link";
  button.dataset.fileReference = path;
  button.title = `Open ${path} in Files`;
  button.textContent = label;
  return button;
}

function referenceLink(value: string) {
  const url = webUrl(value);
  if (!url) return looksLikeFile(value) ? fileButton(value, value) : undefined;
  const link = document.createElement("a");
  link.className = "message-link";
  link.href = url;
  link.title = `Click to open in browser\n${url}`;
  link.textContent = value;
  return link;
}

function linkText(node: Text) {
  const fragment = document.createDocumentFragment();
  let end = 0;
  for (const match of node.data.matchAll(/[^\s<>"'`()[\]{},;]+/g)) {
    const candidate = match[0].replace(/[.:!?]+$/, "");
    const link = referenceLink(candidate);
    if (!link) continue;
    fragment.append(document.createTextNode(node.data.slice(end, match.index)), link);
    end = match.index! + candidate.length;
  }
  if (!end) return;
  fragment.append(document.createTextNode(node.data.slice(end)));
  node.replaceWith(fragment);
}

function linkExplicitPaths(root: DocumentFragment) {
  for (const link of root.querySelectorAll<HTMLElement>("span[data-file-reference]")) {
    const path = link.dataset.fileReference!;
    if (!fileReference(path)) continue;
    const button = fileButton(path, "");
    button.append(...link.childNodes);
    link.replaceWith(button);
  }
}

export function detectFileLinks(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  linkExplicitPaths(template.content);
  for (const code of template.content.querySelectorAll("code")) {
    if (code.closest("pre, a, button")) continue;
    const path = code.textContent ?? "";
    const link = referenceLink(path);
    if (link) code.replaceChildren(link);
  }
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("pre, code, a, button")) nodes.push(node as Text);
  }
  for (const node of nodes) linkText(node);
  return template.innerHTML;
}
