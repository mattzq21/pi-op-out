import type { NativeTransport } from "./nativeTransport";
import type { ComposerUpload, ImageAttachment, RpcCommand } from "../types";
import type { StateUpdate } from "./solid";
import { z } from "zod";

export const goalPreparationSchema = z.object({ objective: z.string(), goalId: z.string().optional(), sessionId: z.string(), sessionPath: z.string().optional(), cwd: z.string(), sessionSaved: z.boolean() });

export async function submissionFingerprint(text: string, uploads: ComposerUpload[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([text, uploads.map(upload => upload.id)])));

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface DraftSubmissionHandle {
  id: string;
  owner: () => NativeTransport;
  move: (destination: NativeTransport) => Promise<void>;
  dispatch: () => Promise<void>;
  accept: () => Promise<void>;
  reject: (reason: string) => Promise<void>;
  uncertain: (reason: string) => Promise<void>;
  wasDispatched: () => boolean;
}

export interface DraftSubmissionPayload {
  rawText: string;
  uploads: ComposerUpload[];
  consume: boolean;
}

export type StageDraftSubmission = (payload: DraftSubmissionPayload) => Promise<DraftSubmissionHandle>;

export const draftUploadsFromImages = (images: ImageAttachment[]) => images.map((image): ComposerUpload => ({ id: crypto.randomUUID(), name: image.name ?? "Image", kind: "image", byteSize: image.data.length * 3 / 4, image }));

export const promptWasAccepted = (result: Awaited<ReturnType<NativeTransport["submitPrompt"]>>) => result !== false;

export async function stageComposerDraft(stage: StageDraftSubmission | undefined, payload: DraftSubmissionPayload, changeDraft: (value: StateUpdate<string>) => void, changeUploads: (value: StateUpdate<ComposerUpload[]>) => void) {
  if (stage) return stage(payload);
  changeDraft(current => current === payload.rawText ? "" : current);
  const ids = new Set(payload.uploads.map(upload => upload.id));
  changeUploads(current => current.filter(item => !ids.has(item.id)));
}

const stages = new WeakMap<NativeTransport, StageDraftSubmission>();

const active = new WeakMap<NativeTransport, DraftSubmissionHandle>();

export function bindDraftStaging(owner: NativeTransport, stage: StageDraftSubmission) { stages.set(owner, stage); }

export function stageDraftSubmission(owner: NativeTransport, payload: DraftSubmissionPayload) {
  const stage = stages.get(owner);

  if (!stage) throw new Error("The draft is not ready to send.");

  return stage(payload);
}

export function ownDraftSubmission(handle: DraftSubmissionHandle, previous?: NativeTransport) {
  if (previous && active.get(previous) === handle) active.delete(previous);
  active.set(handle.owner(), handle);
}

export function releaseDraftSubmission(handle: DraftSubmissionHandle, owner = handle.owner()) {
  if (active.get(owner) === handle) active.delete(owner);
}

export async function submitDraftPrompt(owner: NativeTransport, command: RpcCommand) {
  const submission = active.get(owner);

  if (!submission) throw new Error("The message is not ready to send");

  if (owner.promptControls.missingModel()) throw new Error("Choose a model before sending.");

  await owner.startDraft();

  if (owner.promptControls.hasPending()) await owner.promptControls.flush(value => owner.command(value), enabled => owner.setFastMode(enabled));
  await submission.dispatch();

  return owner.command({ ...command, goalSubmissionId: submission.id });
}
