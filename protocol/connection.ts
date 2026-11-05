// The connection between clients and a daemon, and between daemons. The desktop app has the same values in Rust
// (clients/desktop/protocol).

// A client and a daemon refuse each other when their versions differ.
export const PROTOCOL_VERSION = 1;
// The version of the connection from one daemon to another.
export const PEER_PROTOCOL_VERSION = 1;
// The largest request and answer, in bytes.
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

// The name of a development daemon's storage folder under ~/.piop-dev/daemons. Each source tree has its own daemon.
export function developmentEndpointKey(project: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(project.replace(/\/+$/, '') + '/src-tauri')) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
