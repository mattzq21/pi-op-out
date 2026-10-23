import type { ChatWorktreeRecord, NewChatWorktree } from '../src/chat_worktree_records';

export function archiveRef(chatId: string): string;
export function check(record: unknown): ChatWorktreeRecord;
export function read(root: string, chatId: string): ChatWorktreeRecord | null;
export function list(root: string): ChatWorktreeRecord[];
export function replace(root: string, chatId: string, before: ChatWorktreeRecord | null, after: ChatWorktreeRecord | null): ChatWorktreeRecord | null;
export function prepare(root: string, fields: NewChatWorktree): ChatWorktreeRecord;
export function activate(root: string, chatId: string): ChatWorktreeRecord;
export function fail(root: string, record: ChatWorktreeRecord, message: string): string;
export function processToken(pid?: number): string;
export function ownerAlive(token: unknown): boolean;
