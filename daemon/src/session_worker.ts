import { shellLock } from '../resources/file-lock.cjs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { ensurePrivateDir } from './private_fs';
import * as Registry from './session_registry';
import { readFirstLine, type LaunchCommand } from './pi_launch';

export function hashClaimKey(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest().subarray(0, 20).toString('hex');
}

export function claimsDir(): string {
  const dir = join(homeDir(), STORAGE_DIRECTORY, 'session-claims');
  ensurePrivateDir(dir);
  return dir;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function canonicalUuid(value: string): string | undefined {
  const trimmed = value.trim().replace(/^urn:uuid:/i, '').replace(/^\{(.*)\}$/, '$1');
  if (!UUID.test(trimmed)) return undefined;
  const hex = trimmed.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function claimPath(id: string): string {
  const canonical = canonicalUuid(id);
  if (!canonical) throw new Error('Invalid session identity');
  return join(claimsDir(), `id-${hashClaimKey(canonical)}.lock`);
}

/**
 * The shell wrapper that replaces the Rust session worker. It opens the claim file,
 * locks it with flock, and then replaces itself with Pi so Pi keeps holding the lock.
 */
const WORKER_SCRIPT = [
  'info=$("$PIOP_SESSION_NODE" ${PIOP_SESSION_DAEMON:+"$PIOP_SESSION_DAEMON"} --piop-session-claim "$@") || exit 1',
  'lock=$(printf "%s\\n" "$info" | sed -n 1p)',
  'reserved=$(printf "%s\\n" "$info" | sed -n 2p)',
  'umask 077',
  'exec 9<>"$lock" || { echo "piop session: Could not open a session claim" >&2; exit 1; }',
  shellLock(9, true) + ' || { echo "piop session: This conversation is open in another window or daemon" >&2; exit 1; }',
  'if [ -n "$reserved" ]; then set -- "$@" --session-id "$reserved"; fi',
  'if [ -n "$PIOP_RPC_ENTRY" ]; then exec "${PIOP_NODE:-node}" "$PIOP_RPC_ENTRY" "$@"; fi',
  'exec "$@"',
].join('\n');

export function daemonScript(): string { return Bun.isStandaloneExecutable ? process.execPath : resolve(process.argv[1] ?? ''); }

export function sessionWorkerCommand(piPath: string): LaunchCommand {
  return {
    program: 'sh',
    args: ['-c', WORKER_SCRIPT, 'piop-session', piPath],
    env: { PIOP_BUN: process.execPath, PIOP_SESSION_NODE: process.execPath, PIOP_SESSION_DAEMON: Bun.isStandaloneExecutable ? '' : daemonScript() },
  };
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.lastIndexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Prints the claim lock path and, when a new session was reserved, its identity. */
export function runSessionClaim(): never {
  try {
    const args = process.argv.slice(3);
    const sessionPath = flagValue(args, '--session');
    let id: string;
    let reserved = '';
    if (sessionPath !== undefined) {
      const header = JSON.parse(readFirstLine(sessionPath));
      if (typeof header?.id !== 'string') throw new Error('Missing session identity');
      id = header.id;
    } else {
      const given = flagValue(args, '--session-id');
      if (given !== undefined) id = given;
      else { id = Registry.reserve(join(homeDir(), STORAGE_DIRECTORY)); reserved = id; }
    }
    process.stdout.write(`${claimPath(id)}\n${reserved}\n`);
    process.exit(0);
  } catch (error: any) {
    process.stderr.write(`piop session: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}
