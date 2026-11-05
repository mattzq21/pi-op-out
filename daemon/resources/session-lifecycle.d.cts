export interface SavedSession { sessionId: string; sessionPath: string; archived: boolean }
export function session(root: string, id: string): SavedSession | undefined;
export function idOf(root: string, file: string): string | undefined;
export function descendants(root: string, sessionId: string, filter?: { archived?: boolean; kinds?: string[] }): SavedSession[];
export function archive(root: string, ids: string[]): void;
export function restore(root: string, ids: string[]): void;
export function forget(root: string, ids: string[]): void;
export function run(context: { root: string; begin(): boolean }, request: unknown): { cancelled?: true; busy?: true; warning?: string };
export function sweep(root: string): string[];
