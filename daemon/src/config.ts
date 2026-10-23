export const DEVELOPMENT: boolean = typeof __PIOP_DEVELOPMENT__ === 'boolean' ? __PIOP_DEVELOPMENT__ : false;
export const STORAGE_DIRECTORY = DEVELOPMENT ? '.piop-dev' : '.piop';
export const PROJECT_DIR: string = typeof __PIOP_PROJECT_DIR__ === 'string' ? __PIOP_PROJECT_DIR__ : '';

export const MAX_TERMINALS = 8;
export const BROKER_WORKERS = 8;
export const BROKER_QUEUE_DEPTH = 32;
export const BROKER_HEADER_BYTES = 16 * 1024;
export const BROKER_BODY_BYTES = 1024 * 1024;
export const MAX_AGENT_OUTPUT_BYTES = 16 * 1024 * 1024;

export const PROTOCOL_VERSION = 1;
export const PEER_PROTOCOL_VERSION = 1;
export const BUILD_ID: string = typeof __PIOP_BUILD_ID__ === 'string' ? __PIOP_BUILD_ID__ : '';
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

export function developmentEndpointKey(project: string): string {
  const identity = project.replace(/\/+$/, '') + '/src-tauri';
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(identity, 'utf8')) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
