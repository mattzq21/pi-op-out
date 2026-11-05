export interface LockOptions { shared?: boolean; wait?: boolean; timeoutMs?: number; busy?: string }
export declare function lockSync(name: string, options?: LockOptions): (() => void) | undefined;
export declare function lock(name: string, options?: Omit<LockOptions, 'busy'>): Promise<(() => void) | undefined>;
export declare function holds(name: string): boolean;
export declare function withinFlow<T>(operation: () => T): T;
