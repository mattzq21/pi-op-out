import { required } from "./required";
import { createMemo, createSignal, type Accessor } from "solid-js";
import type { ComposerUpload, Model } from "../types";
import { readDroppedFile } from "./nativeTransport";
import { createDependencyEffect, createRef, type StateUpdate } from "./solid";

interface AttachmentOptions {
  controlledUploads?: ComposerUpload[];
  onUploadsChange?: (uploads: StateUpdate<ComposerUpload[]>) => void;
  model: Model | null;
  models: Model[];
}

const TEXT_LIMIT = 200_000;

const IMAGE_LIMIT = 10 * 1024 * 1024;

const TOTAL_UPLOAD_LIMIT = 24 * 1024 * 1024;

const UPLOAD_COUNT_LIMIT = 12;

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const TEXT_MIME_TYPES = new Set(["application/json", "application/xml", "application/javascript", "application/typescript", "application/x-sh", "application/x-yaml", "application/toml"]);

const TEXT_EXTENSIONS = /\.(?:txt|md|mdx|json|jsonl|ya?ml|toml|xml|csv|tsv|js|jsx|ts|tsx|css|scss|html?|py|rs|go|java|kt|kts|c|cc|cpp|cxx|h|hpp|sh|bash|zsh|fish|sql|graphql|gql|ini|conf|env|log)$/i;

const readFile = (file: File, mode: "text" | "dataUrl") => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);

  if (mode === "dataUrl") reader.readAsDataURL(file); else reader.readAsText(file);
});

function modelSupportsImages(model: Model | null, models: Model[]) {
  return Boolean((model?.input ?? models.find((item) => item.provider === model?.provider && item.id === model?.id)?.input)?.includes("image"));
}

function imageFile(file: File) {
  return file.type.toLowerCase().startsWith("image/") || /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?)$/i.test(file.name);
}

async function imageUpload(file: File, errors: string[]): Promise<ComposerUpload | undefined> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) { errors.push(`${file.name} uses an unsupported image format`);

  return undefined; }

  if (file.size > IMAGE_LIMIT) { errors.push(`${file.name} is larger than 10 MB`);

  return undefined; }

  const url = await readFile(file, "dataUrl");

  try { const image = new Image(); image.src = url; await image.decode(); }
  catch { errors.push(`${file.name} is not a valid image`);

  return undefined; }

  return { id: crypto.randomUUID(), name: file.name, kind: "image", byteSize: file.size, image: { type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type || "image/png", name: file.name } };

}

async function textUpload(file: File, errors: string[]): Promise<ComposerUpload | undefined> {
  if (!(file.type.startsWith("text/") || TEXT_MIME_TYPES.has(file.type.toLowerCase()) || TEXT_EXTENSIONS.test(file.name) || /^(?:Dockerfile|Containerfile|Makefile|README|LICENSE|NOTICE|\.gitignore|\.gitattributes|\.editorconfig)$/i.test(file.name))) { errors.push(`${file.name} is not a supported text file`);

  return undefined; }

  if (file.size > TEXT_LIMIT) { errors.push(`${file.name} is larger than 200 KB`);

  return undefined; }

  let text: string;

  try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
  catch { errors.push(`${file.name} does not contain valid UTF-8 text`);

  return undefined; }

  if (text.includes("\0")) { errors.push(`${file.name} does not contain valid text`);

  return undefined; }

  return { id: crypto.randomUUID(), name: file.name, kind: "text", byteSize: file.size, text };

}

export function useComposerAttachments(options: Accessor<AttachmentOptions>) {
  const [localUploads, setLocalUploads] = createSignal<ComposerUpload[]>([]);
  const uploads = createMemo(() => (options().controlledUploads ?? localUploads()));

  const updateUploads = (update: ComposerUpload[] | ((current: ComposerUpload[]) => ComposerUpload[])) => {
    if (options().onUploadsChange) required((options().onUploadsChange))(update); else setLocalUploads(update);
  };

  const [uploadError, setUploadError] = createSignal<string>();
  const [readingUploads, setReadingUploads] = createSignal(0);
  const [imageInputError, setImageInputError] = createSignal(false);
  const supportsImages = createMemo(() => (modelSupportsImages(options().model, options().models)));
  const supportsImagesRef = createRef(supportsImages());
  createDependencyEffect(() => {
    const capturedSupportsImages = supportsImages();
    supportsImagesRef.current = capturedSupportsImages;
  }, () => [supportsImages()]);
  createDependencyEffect(() => {
    const capturedSupportsImages = supportsImages();

    if (capturedSupportsImages) setImageInputError(false);
  }, () => [supportsImages()]);
  const readUpload = (file: File, errors: string[]) => file.type.startsWith("image/") ? imageUpload(file, errors) : textUpload(file, errors);
  const canUploadImage = (file: File) => !imageFile(file) || supportsImagesRef.current;

  const addFiles = async (files: FileList | File[] | null, initialErrors: string[] = [], commitUploads = options().onUploadsChange ?? setLocalUploads) => { const capturedUploads = uploads();

    if (!files) return;
    setReadingUploads((count) => count + 1);

    try {
      setUploadError(undefined);
      const next: ComposerUpload[] = [];
      const errors = [...initialErrors];
      let totalBytes = capturedUploads.reduce((total, upload) => total + upload.byteSize, 0);

      for (const file of Array.from(files)) {
        if (!canUploadImage(file)) { setImageInputError(true); continue; }

        if (capturedUploads.length + next.length >= UPLOAD_COUNT_LIMIT) { errors.push(`Only ${UPLOAD_COUNT_LIMIT} attachments are allowed`); break; }

        if (file.size + totalBytes > TOTAL_UPLOAD_LIMIT) { errors.push(`${file.name} exceeds the 24 MB attachment limit`); continue; }

        const upload = await readUpload(file, errors);

        if (!upload) continue;
        next.push(upload);
        totalBytes += file.size;
      }

      commitUploads((current) => {
        const accepted: ComposerUpload[] = [];
        let currentBytes = current.reduce((total, upload) => total + upload.byteSize, 0);

        for (const upload of next) {
          if (upload.kind === "image" && !supportsImagesRef.current) { setImageInputError(true); continue; }

          if (current.length + accepted.length >= UPLOAD_COUNT_LIMIT) { errors.push(`Only ${UPLOAD_COUNT_LIMIT} attachments are allowed`); break; }

          if (currentBytes + upload.byteSize > TOTAL_UPLOAD_LIMIT) { errors.push(`${upload.name} exceeds the 24 MB attachment limit`); continue; }

          accepted.push(upload); currentBytes += upload.byteSize;
        }

        if (errors.length) setUploadError([...new Set(errors)].join(". "));

        return [...current, ...accepted];
      });
    } finally { setReadingUploads((count) => count - 1); }
  };

  const addPaths = async (paths: string[], cancelled = () => false) => {
    setReadingUploads((count) => count + 1);

    try {
      const commitUploads = options().onUploadsChange ?? setLocalUploads;
      const files: File[] = [];
      const errors = paths.length > UPLOAD_COUNT_LIMIT ? [`Only ${UPLOAD_COUNT_LIMIT} attachments are allowed; extra files were skipped`] : [];

      for (const path of paths.slice(0, UPLOAD_COUNT_LIMIT)) {
        if (cancelled()) return;

        try { files.push(await readDroppedFile(path)); }
        catch (reason) { errors.push(reason instanceof Error ? reason.message : String(reason)); }
      }

      if (!cancelled()) await addFiles(files, errors, commitUploads);
    } finally { setReadingUploads((count) => count - 1); }
  };

  const acceptsImages = (count: number) => {
    if (count && !supportsImagesRef.current) { setImageInputError(true);

    return false; }

    return true;
  };

  const captureUploadWriter = () => options().onUploadsChange ?? setLocalUploads;

  return { uploads, updateUploads, uploadError, setUploadError, readingUploads, imageInputError, setImageInputError, addFiles, addPaths, acceptsImages, captureUploadWriter };
}
