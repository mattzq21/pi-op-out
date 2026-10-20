import type { DatabaseSync } from "node:sqlite";

export function open(root: string): DatabaseSync;
export function initialize(database: DatabaseSync): void;
export function reserveId(database: DatabaseSync): string;
export function pending(database: DatabaseSync, work: "transaction" | "recovery" | "retention"): boolean;
export function register(database: DatabaseSync, sessionId: string, sessionPath: string): void;
export function storageRoot(file: string): string;
export function lookup(root: string, sessionId: string): string | null | undefined;
export function markCleanup(root: string, kind: "goal"): void;
