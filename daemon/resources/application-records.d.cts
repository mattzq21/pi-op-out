export type RecordName = 'settings' | 'agent-definitions' | 'daemon' | 'daemon-id' | 'debug-mobile' | 'debug-mobile-identity' | 'plugins';
export declare function read(root: string, name: RecordName): Buffer | undefined;
export declare function readJson(root: string, name: RecordName): any;
export declare function save(root: string, name: RecordName, value: Buffer | string): void;
export declare function removeIfEqual(root: string, name: RecordName, expected: Buffer | string): boolean;
export declare function readOrCreate(root: string, name: RecordName, initial: Buffer | string): Buffer;
