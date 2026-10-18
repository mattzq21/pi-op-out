import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as system from '../../daemon/src/tailscale_system';

const read = (name: string) => readFileSync(join(process.env.HOME!, name), 'utf8');

export const peerCredentials: typeof system.peerCredentials = async () => JSON.parse(read('.fake-peer-credentials'));

export const run: typeof system.run = async (program, args) => {
  if (program === '/usr/bin/tailscale' && JSON.stringify(args) === JSON.stringify(['status', '--json'])) {
    return { ok: true, stdout: read('.fake-tailscale-status') };
  }
  if (program === '/usr/bin/systemctl' && JSON.stringify(args) === JSON.stringify(['--system', 'show', 'tailscaled.service', '--property=MainPID', '--value'])) {
    return { ok: true, stdout: read('.fake-tailscaled-pid') };
  }
  throw new Error('Unexpected Tailscale system call: ' + program + ' ' + JSON.stringify(args));
};
