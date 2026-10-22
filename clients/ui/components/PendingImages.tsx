import { createResource, Index, Show } from "solid-js";
import { ImageOff } from "lucide-solid";
import type { PendingMessage } from "../types";

/** Loads the data of one image of a queued message. */
export type PendingImageLoader = (id: string, index: number) => Promise<{ data: string; mimeType: string }>;

/** Loaded image sources, by message ID and image index. A queued message keeps its images, so each loads once. */
const sources = new Map<string, Promise<string>>();

function source(message: PendingMessage, index: number, load: PendingImageLoader | undefined) {
  const image = message.images?.[index];

  if (image?.data) return Promise.resolve(`data:${image.mimeType};base64,${image.data}`);
  if (!load) return Promise.reject(new Error("This view cannot load queued images"));
  const key = `${message.id}:${index}`;
  let pending = sources.get(key);

  if (!pending) {
    pending = load(message.id, index).then(loaded => `data:${loaded.mimeType};base64,${loaded.data}`);
    pending.catch(() => sources.delete(key));
    sources.set(key, pending);
  }

  return pending;
}

function PendingImage(props: { message: PendingMessage; index: number; load?: PendingImageLoader }) {
  const [src] = createResource(() => [props.message, props.index] as const, ([message, index]) => source(message, index, props.load));
  const label = () => props.message.images?.[props.index]?.name ?? "Attached image";

  return <Show when={!src.error} fallback={<span class="pending-image pending-image-missing" role="img" aria-label={`${label()} could not load`} data-tooltip={`Could not show the image: ${src.error instanceof Error ? src.error.message : String(src.error)}`}><ImageOff size={12} /></span>}>
    <img class="pending-image" src={src()} alt={label()} />
  </Show>;
}

/** Small previews of the images of a queued message. */
export function PendingImages(props: { message: PendingMessage; load?: PendingImageLoader }) {
  return <Show when={props.message.images?.length}><span class="pending-images"><Index each={props.message.images}>{(_image, index) => <PendingImage message={props.message} index={index} load={props.load} />}</Index></span></Show>;
}
