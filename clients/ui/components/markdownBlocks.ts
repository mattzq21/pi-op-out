import { markdownDiagrams } from "./markdownDiagrams";

type MountedBlock = { html?: string; end: Comment; nodes: ChildNode[]; hasDiagrams?: boolean; diagrams: ReturnType<typeof markdownDiagrams> };

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

function updateBlock(root: HTMLElement, block: MountedBlock, value: string) {
  const container = document.createElement("div");
  container.innerHTML = value;
  const hasDiagrams = Boolean(container.querySelector(".diagram-placeholder"));

  if (!hasDiagrams && !block.hasDiagrams) block.nodes = updateNodes(root, block.nodes, [...container.childNodes], block.end);
  else {
    block.nodes.forEach(node => node.remove());
    root.insertBefore(container, block.end);
    block.diagrams.update(container);
    block.nodes = [...container.childNodes];
    const fragment = document.createDocumentFragment();
    fragment.append(...block.nodes);
    root.insertBefore(fragment, block.end);
    container.remove();
  }

  block.hasDiagrams = hasDiagrams;
  block.html = value;
}

export function markdownBlocks() {
  const blocks: MountedBlock[] = [];

  const disposeBlock = (block: MountedBlock) => {
    block.diagrams.dispose();
    block.nodes.forEach(node => node.remove());
    block.end.remove();
  };

  return {
    update(root: HTMLElement, html: string[]) {
      html.forEach((value, index) => {
        let block = blocks[index];

        if (!block) {
          block = { end: document.createComment(""), nodes: [], diagrams: markdownDiagrams() };
          blocks.push(block);
          root.append(block.end);
        }

        if (block.html === value) return;
        updateBlock(root, block, value);
      });
      blocks.splice(html.length).forEach(disposeBlock);
    },
    dispose() { blocks.splice(0).forEach(disposeBlock); },
  };
}
