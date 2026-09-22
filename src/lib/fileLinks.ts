import { fileReference, looksLikeFile } from "./projectFiles";

function fileButton(path: string, label: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "file-link";
  button.dataset.fileReference = path;
  button.title = `Open ${path} in Files`;
  button.textContent = label;
  return button;
}

function linkText(node: Text) {
  const fragment = document.createDocumentFragment();
  let end = 0;
  for (const match of node.data.matchAll(/[^\s<>"'`()[\]{},;!?]+/g)) {
    const candidate = match[0].replace(/[.:]+$/, "");
    if (!looksLikeFile(candidate)) continue;
    fragment.append(document.createTextNode(node.data.slice(end, match.index)), fileButton(candidate, candidate));
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
    if (looksLikeFile(path)) code.replaceChildren(fileButton(path, path));
  }
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("pre, code, a, button")) nodes.push(node as Text);
  }
  for (const node of nodes) linkText(node);
  return template.innerHTML;
}
