export function capSessionName(name: string): string;
export function validName(name: unknown): string;
export function sessionName(file: string, sessionId: string): string | undefined;
export function nameSession(file: string, sessionId: string, name: string, replace?: boolean): void;
export function renameSession(root: string, sessionId: string, name: string): string;
