import type { TSchema } from "typebox";

export interface GoalAttachment { name: string; text?: string; image?: { data: string; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" } | null }
export interface GoalDraft { objective: string; attachments: GoalAttachment[] }
export interface GoalPreparation {
  version: 1; submissionId: string; digest: string; objective: string; sessionId: string; sessionPath?: string; cwd: string;
  goalId?: string; expectedState?: string; input?: GoalDraft; files?: Array<{ name: string; data: string; digest: string }>;
}

export declare const draftSchema: TSchema;
export declare function parsePreparation(text: string): GoalPreparation;
export declare function read(root: string, directory: string): GoalPreparation | undefined;
export declare function save(root: string, directory: string, record: GoalPreparation, destination?: string): string;
export declare function retained(root: string, directory: string, expected: string): boolean;
export declare function remove(root: string, directory: string, expected: string): void;
