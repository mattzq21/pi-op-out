type Method = (...args: any[]) => any;

export declare function requireMethods(target: unknown, names: string[], owner?: string): void;
export declare function patchMethod<T extends Method>(target: unknown, name: string, replace: (original: T) => Method, owner?: string): T;
export declare function patchGetter(target: unknown, name: string, replace: (original: () => unknown) => () => unknown, owner?: string): void;
