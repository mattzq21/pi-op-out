import { onCleanup } from "solid-js";
import { z } from "zod";
import { clipboardImageFile, pastedFiles, readClipboardImages } from "./clipboardImages";

const nativeImageSchema = z.object({ data: z.string().optional(), mimeType: z.string().optional(), error: z.string().optional() });

const pasteShortcut = (event: KeyboardEvent) => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && !event.altKey;

interface Options {
  field: () => HTMLElement | null | undefined;
  enabled: () => boolean;
  start: () => (files: File[]) => Promise<void>;
  error: (message: string) => void;
}

export function createFilePaste(options: Options) {
  let revision = 0;
  const failed = (reason: unknown) => options.error(reason instanceof Error ? reason.message : String(reason));

  const onPaste = (event: ClipboardEvent) => {
    revision += 1;

    if (!event.clipboardData || !options.enabled()) return;
    const files = pastedFiles(event.clipboardData);

    if (!files.length && event.clipboardData.getData("text/plain")) return;
    event.preventDefault();
    const add = options.start();
    void (files.length ? Promise.resolve(files) : readClipboardImages()).then(add).catch(failed);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!pasteShortcut(event) || !options.enabled()) return;
    const started = revision;
    const field = options.field();
    const add = options.start();
    setTimeout(() => {
      if (started !== revision || !field?.isConnected || document.activeElement !== field) return;
      void readClipboardImages().then(files => files.length ? add(files) : undefined).catch(failed);
    }, 0);
  };

  const onNative = (event: Event) => {
    if (!(event instanceof CustomEvent) || event.target !== options.field() || !options.enabled()) return;
    const parsed = nativeImageSchema.safeParse(event.detail);

    if (!parsed.success) return;

    if (parsed.data.error) { options.error(parsed.data.error);

    return; }

    if (parsed.data.data) void options.start()([clipboardImageFile(parsed.data.data, parsed.data.mimeType)]).catch(failed);
  };

  document.addEventListener("piop-native-image-paste", onNative);
  onCleanup(() => document.removeEventListener("piop-native-image-paste", onNative));

  return { onPaste, onKeyDown };
}
