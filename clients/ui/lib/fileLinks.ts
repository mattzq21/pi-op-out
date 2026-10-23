import { required } from "./required";
import { fileReference, looksLikeFile } from "./projectFiles";
import { webUrl } from "./webLinks";

function fileButton(path: string, label: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "file-link";
  button.dataset.fileReference = path;
  button.textContent = label;

  return button;
}

function referenceLink(value: string, allowFile: (value: string) => boolean) {
  const url = webUrl(value);

  if (!url) return looksLikeFile(value) && allowFile(value) ? fileButton(value, value) : undefined;
  const link = document.createElement("a");
  link.className = "message-link";
  link.href = url;
  link.textContent = value;

  return link;
}

function referenceText(value: string) {
  let end = value.length;

  while (end > 0 && ".:!?".includes(value[end - 1])) end--;

  return value.slice(0, end);
}

function linkText(node: Text, allowFile: (value: string) => boolean) {
  const text = node.data;
  let fragment: DocumentFragment | undefined;
  let end = 0;

  for (const match of text.matchAll(/[^\s<>"'`()[\]{},;]+/g)) {
    const candidate = referenceText(match[0]);
    const link = referenceLink(candidate, allowFile);

    if (!link) continue;
    fragment ??= document.createDocumentFragment();
    fragment.append(document.createTextNode(text.slice(end, match.index)), link);
    end = match.index + candidate.length;
  }

  if (!fragment) return;
  fragment.append(document.createTextNode(text.slice(end)));
  node.replaceWith(fragment);
}

function linkExplicitPaths(root: DocumentFragment, allowFile: (value: string) => boolean) {
  for (const link of root.querySelectorAll<HTMLElement>("span[data-file-reference]")) {
    const path = required(link.dataset.fileReference);

    if (!fileReference(path) || !allowFile(path)) continue;
    const button = fileButton(path, "");
    if (link.dataset.imageLabel !== undefined) button.dataset.imageLabel = link.dataset.imageLabel;
    button.append(...link.childNodes);
    link.replaceWith(button);
  }
}

export function detectFileLinks(html: string | DocumentFragment, allowFile = (_value: string) => true) {
  const template = document.createElement("template");

  if (html instanceof DocumentFragment) template.content.append(html);
  else template.innerHTML = html;
  linkFileReferences(template.content, allowFile);

  return template.innerHTML;
}

export function linkFileReferences(root: DocumentFragment, allowFile = (_value: string) => true) {
  return linkAllowedFileReferences(root, allowFile);
}

function linkAllowedFileReferences(root: DocumentFragment, allowFile: (value: string) => boolean) {
  linkExplicitPaths(root, allowFile);

  for (const code of root.querySelectorAll("code")) {
    if (code.closest("pre, a, button")) continue;
    const path = code.textContent ?? "";
    const link = referenceLink(path, allowFile);

    if (link) code.replaceChildren(link);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && !node.parentElement?.closest("pre, code, a, button")) nodes.push(node);
  }

  for (const node of nodes) linkText(node, allowFile);

  return root;
}
