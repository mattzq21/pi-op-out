import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Diagram } from "./Diagram";

function mountDiagram(host: HTMLDivElement, source: string, complete: boolean) {
  const [value, setValue] = createSignal(source);
  const [closed, setClosed] = createSignal(complete);
  const dispose = render(() => <Diagram source={value()} complete={closed()} />, host);

  return { host, dispose, update: (text: string, ready: boolean) => { setValue(text); setClosed(ready); } };
}

export function markdownDiagrams() {
  let mounts: ReturnType<typeof mountDiagram>[] = [];

  return {
    update(root: HTMLElement) {
      const slots = [...root.querySelectorAll<HTMLElement>(".diagram-placeholder")];

      const next = slots.map((slot, index) => {
        const source = slot.querySelector("code")?.textContent ?? "";
        const complete = slot.dataset.complete === "true";
        const previous = mounts[index];

        if (previous) { slot.replaceWith(previous.host); previous.update(source, complete);

        return previous; }

        const host = document.createElement("div");
        slot.replaceWith(host);

        return mountDiagram(host, source, complete);
      });

      mounts.slice(next.length).forEach(mount => mount.dispose());
      mounts = next;
    },
    dispose() { mounts.forEach(mount => mount.dispose()); mounts = []; },
  };
}
