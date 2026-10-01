import { required } from "./required";
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

function referenceText(value: string) {
  let end = value.length;

  while (end > 0 && ".:!?".includes(value[end - 1])) end--;

  return value.slice(0, end);
}

function linkText(node: Text) {
  const text = node.data;
  let fragment: DocumentFragment | undefined;
  let end = 0;

  for (const match of text.matchAll(/[^\s<>"'`()[\]{},;]+/g)) {
    const candidate = referenceText(match[0]);
    const link = referenceLink(candidate);

    if (!link) continue;
    fragment ??= document.createDocumentFragment();
    fragment.append(document.createTextNode(text.slice(end, match.index)), link);
    end = match.index + candidate.length;
  }

  if (!fragment) return;
  fragment.append(document.createTextNode(text.slice(end)));
  node.replaceWith(fragment);
}

function linkExplicitPaths(root: DocumentFragment) {
  for (const link of root.querySelectorAll<HTMLElement>("span[data-file-reference]")) {
    const path = required(link.dataset.fileReference);

    if (!fileReference(path)) continue;
    const button = fileButton(path, "");
    button.append(...link.childNodes);
    link.replaceWith(button);
  }
}

export function detectFileLinks(html: string | DocumentFragment) {
  const template = document.createElement("template");

  if (typeof html === "string") template.innerHTML = html;
  else template.content.append(html);
  linkFileReferences(template.content);

  return template.innerHTML;
}

export function linkFileReferences(root: DocumentFragment) {
  linkExplicitPaths(root);

  for (const code of root.querySelectorAll("code")) {
    if (code.closest("pre, a, button")) continue;
    const path = code.textContent ?? "";
    const link = referenceLink(path);

    if (link) code.replaceChildren(link);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("pre, code, a, button")) nodes.push(node as Text);
  }

  for (const node of nodes) linkText(node);

  return root;
}
