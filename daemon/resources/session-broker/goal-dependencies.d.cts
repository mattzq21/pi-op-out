export function saveTextFiles(root: string, directory: string, names: string[], destination?: string): void;
export function removeTextFiles(root: string, directory: string, expected: string): void;
export function read(root: string, directory: string): { directories: Array<{ path: string; identity: string }> } | undefined;
export function textContents(root: string, directory: string): Array<{ name: string; text: string }>;
export function savePreparedText(root: string, directory: string, names: string[], preparation: string, destination?: string): string;
export function removePreparedText(root: string, directory: string, expected: string): void;
