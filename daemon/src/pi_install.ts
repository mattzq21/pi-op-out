import { installPi } from '../resources/pi-install.cjs';
import manifest from '../resources/pi/package.json?raw' with { type: 'text' };
import lockfile from '../resources/pi/bun.lock?raw' with { type: 'text' };
import { homeDir } from './environment';

export interface InstalledPi {
  // The folder of the Pi package.
  root: string;
  // Pi's program, which Node runs.
  cli: string;
}

let checking: Promise<InstalledPi> | undefined;

// Piop's own Pi, checked on each call. A missing Pi is installed; calls made during the install share it.
export function installedPi(): Promise<InstalledPi> {
  checking ??= installPi({ home: homeDir(), manifest, lockfile, bun: process.execPath, log: line => console.error(line) })
    .finally(() => { checking = undefined; });
  return checking;
}
