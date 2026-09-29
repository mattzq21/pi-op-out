import { markdownDiagrams } from "./markdownDiagrams";

type MountedBlock = { html?: string; end: Comment; nodes: ChildNode[]; diagrams: ReturnType<typeof markdownDiagrams> };

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
        block.nodes.forEach(node => node.remove());
        const container = document.createElement("div");
        container.innerHTML = value;
        root.insertBefore(container, block.end);
        block.diagrams.update(container);
        block.nodes = [...container.childNodes];
        const fragment = document.createDocumentFragment();
        fragment.append(...block.nodes);
        root.insertBefore(fragment, block.end);
        container.remove();
        block.html = value;
      });
      blocks.splice(html.length).forEach(disposeBlock);
    },
    dispose() { blocks.splice(0).forEach(disposeBlock); },
  };
}
