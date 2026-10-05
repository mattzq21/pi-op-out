import { markdownDiagrams } from "./markdownDiagrams";
import { imageReference, markdownImages } from "./markdownImages";
import type { FileProject } from "../lib/projectFiles";

type MountedBlock = { html?: string; project?: string; end: Comment; nodes: ChildNode[]; hasEmbeds?: boolean; diagrams: ReturnType<typeof markdownDiagrams>; images: ReturnType<typeof markdownImages> };

function sameElement(previous: Element, next: Element) {
  return previous.tagName === next.tagName && previous.namespaceURI === next.namespaceURI
    && previous.attributes.length === next.attributes.length
    && [...previous.attributes].every(attribute => next.getAttributeNS(attribute.namespaceURI, attribute.localName) === attribute.value);
}

function updateNodes(root: Element, current: ChildNode[], next: ChildNode[], before: ChildNode | null = null): ChildNode[] {
  const retained = next.map((incoming, index) => {
    const previous = current[index];

    if (!previous) root.insertBefore(incoming, before);
    else if (previous.isEqualNode(incoming)) return previous;
    else if (previous instanceof Element && incoming instanceof Element && sameElement(previous, incoming)) {
      updateNodes(previous, [...previous.childNodes], [...incoming.childNodes]);

      return previous;
    } else root.replaceChild(incoming, previous);

    return incoming;
  });

  for (const node of current.slice(next.length)) node.remove();

  return retained;
}

function updateBlock(root: HTMLElement, block: MountedBlock, value: string, project?: FileProject) {
  const container = document.createElement("div");
  container.innerHTML = value;
  const hasEmbeds = Boolean(container.querySelector(".diagram-placeholder") || project && [...container.querySelectorAll<HTMLElement>("[data-file-reference]")].some(slot => imageReference(slot)));

  if (!hasEmbeds && !block.hasEmbeds) block.nodes = updateNodes(root, block.nodes, [...container.childNodes], block.end);
  else {
    block.nodes.forEach(node => node.remove());
    root.insertBefore(container, block.end);
    block.diagrams.update(container);
    block.images.update(container, project);
    block.nodes = [...container.childNodes];
    const fragment = document.createDocumentFragment();
    fragment.append(...block.nodes);
    root.insertBefore(fragment, block.end);
    container.remove();
  }

  block.hasEmbeds = hasEmbeds;
  block.html = value;
}

export function markdownBlocks() {
  const blocks: MountedBlock[] = [];

  const disposeBlock = (block: MountedBlock) => {
    block.diagrams.dispose();
    block.images.dispose();
    block.nodes.forEach(node => node.remove());
    block.end.remove();
  };

  return {
    update(root: HTMLElement, html: string[], project?: FileProject) {
      html.forEach((value, index) => {
        let block = blocks[index];

        if (!block) {
          block = { end: document.createComment(""), nodes: [], diagrams: markdownDiagrams(), images: markdownImages() };
          blocks.push(block);
          root.append(block.end);
        }

        const key = JSON.stringify(project);

        if (block.html === value && block.project === key) return;

        updateBlock(root, block, value, project);
        block.project = key;
      });
      blocks.splice(html.length).forEach(disposeBlock);
    },
    dispose() { blocks.splice(0).forEach(disposeBlock); },
  };
}
