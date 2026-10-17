import { createContext, createResource, createSignal, Show, type Accessor } from "solid-js";
import { render } from "solid-js/web";
import { z } from "zod";
import { nativeCall } from "../lib/nativeCall";
import { fileReference, type FileProject } from "../lib/projectFiles";
import { ImageLoading, ZoomableImage } from "./ZoomableImage";

export const ConversationImageProject = createContext<Accessor<FileProject | undefined>>(() => undefined);

export function imageFileReference(value: string) {
  const reference = fileReference(value);

  return reference && /\.(png|jpe?g|gif|webp)$/i.test(reference.path) ? reference : undefined;
}

export const imageReference = (slot: HTMLElement) => imageFileReference(slot.dataset.fileReference ?? "");

function LinkedImage(props: { project: FileProject; path: string; label: string }) {
  const [failed, setFailed] = createSignal(false);

  const [image] = createResource(() => ({ ...props.project, path: props.path }), async args => {
    setFailed(false);

    try { return await nativeCall("read_image_file", args, z.string().regex(/^data:image\/(png|jpeg|gif|webp);base64,/)); }
    catch { setFailed(true);

    return undefined; }
  });

  return <Show when={!failed() && image()} fallback={<Show when={failed()} fallback={<ImageLoading />}><span role="status">{props.label}: Image unavailable</span></Show>}>
    {src => <ZoomableImage src={src()} alt={props.label} onError={() => setFailed(true)} />}
  </Show>;
}

export function markdownImages() {
  let mounts: Array<{ path: string; label: string; project: string; host: HTMLSpanElement; dispose: () => void }> = [];

  return {
    update(root: HTMLElement, target: HTMLElement, project?: FileProject) {
      const next: typeof mounts = [];

      if (project) for (const slot of root.querySelectorAll<HTMLElement>("[data-file-reference]")) {
        const reference = imageReference(slot);

        if (!reference) continue;
        const label = slot.dataset.imageLabel || slot.textContent || reference.path;
        const key = JSON.stringify(project);
        const previous = mounts[next.length];

        if (previous?.path === reference.path && previous.label === label && previous.project === key) {
          next.push(previous);
          continue;
        }

        const host = document.createElement("span");
        host.className = "linked-message-image";
        const dispose = render(() => <LinkedImage project={project} path={reference.path} label={label} />, host);
        next.push({ path: reference.path, label, project: key, host, dispose });
      }

      mounts.filter(mount => !next.includes(mount)).forEach(mount => { mount.dispose(); mount.host.remove(); });
      next.forEach((mount, index) => { if (target.children[index] !== mount.host) target.insertBefore(mount.host, target.children[index] ?? null); });
      target.hidden = next.length === 0;
      mounts = next;
    },
    open(path: string) {
      const mount = mounts.find(image => image.path === path);
      const preview = mount?.host.querySelector<HTMLButtonElement>("button.image-preview");

      if (!preview || preview.disabled) return false;
      preview.click();

      return true;
    },
    dispose() { mounts.forEach(mount => mount.dispose()); mounts = []; },
  };
}
