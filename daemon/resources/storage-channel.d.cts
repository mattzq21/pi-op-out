export declare function call(operation: string, payload: unknown): unknown;
export declare function claim(): number | null;
export declare function hasChannel(): boolean;
export declare const transcriptWrites: Record<'publish' | 'append' | 'repair' | 'bind' | 'selectBranch' | 'copyGoal', (request: unknown) => unknown>;
