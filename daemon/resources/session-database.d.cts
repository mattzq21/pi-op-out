import type { DatabaseSync } from "node:sqlite";

// The shared connection of this process. Never close it.
export type Connection = Omit<DatabaseSync, "close">;

export function readOnlyStorage(): void;
export function connection(root: string): Connection;
export function transaction<T>(database: Connection, behavior: "IMMEDIATE" | "DEFERRED" | "EXCLUSIVE", operation: () => T): T;
export function rollback(database: Connection, error: unknown): unknown;
export function reserveId(database: Connection): string;
export function touch(database: Connection, sessionId: string): void;
export function revise(root: string, sessionId: string): void;
export function storageRoot(file: string): string;
export function lookup(root: string, sessionId: string): string | null | undefined;
