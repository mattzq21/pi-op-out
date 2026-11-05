export declare function onMainThread<Args extends unknown[], Result>(name: string, operation: (...args: Args) => Result, options?: { inTransaction?: boolean }): (...args: Args) => Result;
export declare function connectWorker(port: import('node:worker_threads').MessagePort, signal: SharedArrayBuffer): void;
export declare function serveWorker(port: import('node:worker_threads').MessagePort, signal: SharedArrayBuffer): void;
export declare function linkedWorker(): boolean;
export declare function holdTransaction(): () => void;
export declare function servesWorkers(): boolean;
export declare function currentCaller(): { ended: boolean; end: Set<() => void> } | undefined;
