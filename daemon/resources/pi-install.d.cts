export declare function installName(manifest: string, lockfile: string): string;
export declare function installPi(options: { home: string; manifest: string; lockfile: string; bun: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void }): Promise<{ root: string; cli: string }>;
