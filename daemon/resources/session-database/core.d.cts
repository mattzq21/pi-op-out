import type { DatabaseSync } from "node:sqlite";

// The shared connection of this process. Never close it. Only the modules in session-database/ and tests use it.
export type Connection = Omit<DatabaseSync, "close">;
export function connection(root: string): Connection;
export function transaction<T>(root: string, behavior: "IMMEDIATE" | "DEFERRED" | "EXCLUSIVE", operation: () => T): T;
export function transactionOf<T>(database: Connection, behavior: "IMMEDIATE" | "DEFERRED" | "EXCLUSIVE", operation: () => T): T;
export function rows(root: string, sql: string, ...parameters: any[]): any[];
export * from "../session-database.cjs";
