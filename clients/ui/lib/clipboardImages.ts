import { z } from "zod";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { decodeBase64 } from "./base64";

export function pastedFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);

  if (files.length) return files;

  return Array.from(data.items).flatMap(item => {
    const file = item.kind === "file" ? item.getAsFile() : null;

    return file ? [file] : [];
  });
}

export async function readClipboardImages(): Promise<File[]> {
  if (isTauri()) {
    const image = z.string().nullable().parse(await invoke("read_clipboard_image"));

    if (image) return [clipboardImageFile(image)];
  }

  if (!navigator.clipboard?.read) return [];
  const items = await navigator.clipboard.read();
  const files: File[] = [];

  for (const item of items) {
    const type = item.types.find(type => type.startsWith("image/"));

    if (!type) continue;
    const blob = await item.getType(type);
    files.push(new File([blob], `Pasted image.${type.slice(6)}`, { type }));
  }

  return files;
}

export function clipboardImageFile(data: string, mimeType = "image/png") {
  return new File([decodeBase64(data)], `Pasted image.${mimeType.slice(6)}`, { type: mimeType });
}
