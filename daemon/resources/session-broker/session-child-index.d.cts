export function tree(root: string, sessionId: string): string[];
export function children(root: string, parentId: string): Array<{ sessionId: string; kind: string; archived: boolean }>;
