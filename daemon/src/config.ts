import { developmentEndpointKey } from '../../protocol/connection';
export const DEVELOPMENT: boolean = typeof __PIOP_DEVELOPMENT__ === 'boolean' ? __PIOP_DEVELOPMENT__ : false;
export const UNUSED_STOP_MS: number | undefined = typeof __PIOP_UNUSED_STOP_MS__ === 'number' ? __PIOP_UNUSED_STOP_MS__ : DEVELOPMENT ? 5_000 : undefined;
export const PROJECT_DIR: string = typeof __PIOP_PROJECT_DIR__ === 'string' ? __PIOP_PROJECT_DIR__ : '';
// The storage folder, relative to HOME. Only one daemon uses it at a time: each development checkout has its own.
export const STORAGE_DIRECTORY = DEVELOPMENT ? developmentStorageDirectory() : '.piop';

export const MAX_TERMINALS = 8;
export const BROKER_WORKERS = 8;
export const BROKER_QUEUE_DEPTH = 32;
export const MAX_AGENT_OUTPUT_BYTES = 16 * 1024 * 1024;

export { PROTOCOL_VERSION, PEER_PROTOCOL_VERSION, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from '../../protocol/connection';
export const BUILD_ID: string = typeof __PIOP_BUILD_ID__ === 'string' ? __PIOP_BUILD_ID__ : '';

function developmentStorageDirectory(): string {
  if (!PROJECT_DIR) throw new Error('Cannot locate project directory');
  return '.piop-dev/daemons/' + developmentEndpointKey(PROJECT_DIR);
}

export { developmentEndpointKey };
