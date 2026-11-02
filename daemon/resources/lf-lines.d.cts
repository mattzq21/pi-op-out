import type { Readable } from "node:stream";

export function readLines(input: Readable, onLine: (line: string) => void, onEnd?: () => void): () => void;
export function lines(input: Readable): AsyncGenerator<string>;
