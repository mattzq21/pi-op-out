import { join } from 'node:path';
import { homeDir, isFile } from './environment';
import { shellQuote, type CommandSpec } from './process_io';
import { validateRemoteHost, type AppSettings, type RemoteHost } from './settings_types';

/** Stored data of another machine changes only through the Piop daemon of that machine. Requests for it go there through peers. */
export function requireLocal(hostId: string): void {
  if (hostId !== 'local') throw new Error('Requests for another host must go through the Piop daemon of that host');
}

export function remoteHost(settings: AppSettings, hostId: string): RemoteHost {
  const host = settings.hosts.find(host => host.id === hostId);
  if (!host) throw new Error(`Unknown host: ${hostId}`);
  if (!host.enabled) throw new Error(`Host ${host.name} is disabled`);
  validateRemoteHost(host);
  return host;
}

export function userSshConfig(): string | undefined {
  try { const path = join(homeDir(), '.ssh/config'); return isFile(path) ? path : undefined; } catch { return undefined; }
}

export function remoteLoginCommand(command: string): string { return `bash -lc ${shellQuote('PATH="$PATH:$HOME/.bun/bin"; ' + command)}`; }

export function sshBase(): CommandSpec {
  const args: string[] = [];
  const config = userSshConfig();
  if (config) args.push('-F', config);
  args.push('-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3');
  return { program: 'ssh', args };
}

export function ssh(host: RemoteHost, ...extra: string[]): CommandSpec {
  const command = sshBase();
  command.args!.push(host.target, ...extra);
  return command;
}
