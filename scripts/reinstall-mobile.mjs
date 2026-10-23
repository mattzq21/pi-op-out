import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const home = homedir();

const env = { ...process.env, VITE_PIOP_DEBUG: "true" };

const localProperties = join(root, 'clients/android/local.properties');

const configuredSdk = existsSync(localProperties)
  ? readFileSync(localProperties, 'utf8').match(/^sdk\.dir=(.+)$/m)?.[1].trim().replace(/\\([\\: ])/g, '$1')
  : undefined;

const sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, configuredSdk, join(home, 'Android/Sdk')]
  .find((path) => path && existsSync(join(path, 'platform-tools/adb')));

const adb = sdk ? join(sdk, 'platform-tools/adb') : 'adb';

if (sdk) env.ANDROID_HOME = sdk;

if (!env.JAVA_HOME) {
  const java = [join(home, 'Applications/android-studio/jbr'), '/opt/android-studio/jbr']
    .find((path) => existsSync(join(path, 'bin/java')));

  if (java) env.JAVA_HOME = java;
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });

  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);

  if (result.status !== 0) throw new Error(`${command} failed${capture ? `: ${result.stderr.trim()}` : ''}`);

  return result.stdout;
}

function wirelessAddress(connection) {
  const target = `unix:${join(connection.runtime.daemonDirectory, 'tailscale.sock')}`;
  console.log('Configuring wireless Tailscale access (sudo may request your password)…');
  run('sudo', ['tailscale', 'serve', '--bg', '--https=443', '--yes', target]);
  const configuration = JSON.parse(run('tailscale', ['serve', 'status', '--json'], true));
  const route = Object.entries(configuration.Web ?? {}).find(([address, site]) => address.endsWith(':443') && site.Handlers?.['/']?.Proxy === target);

  if (!route) throw new Error('Could not find the rebuilt daemon’s Tailscale address.');

  return `wss://${route[0].replace(/:443$/, '')}/`;
}

function readDevices() {
  return run(adb, ['devices', '-l'], true).split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(\S+)\s+(device|offline|unauthorized|no permissions)(?:\s|$)/);

    return match ? [{ serial: match[1], state: match[2], usb: /\susb:/.test(line) }] : [];
  });
}

function chooseDevice(devices, requested) {
  const ready = devices.filter(device => device.state === 'device');

  if (requested) return ready.find(device => device.serial === requested)?.serial;
  const usb = ready.filter(device => device.usb);

  if (usb.length === 1) return usb[0].serial;

  if (ready.length === 1) return ready[0].serial;

  if (ready.length > 1) throw new Error(`Multiple Android devices are ready: ${ready.map(device => device.serial).join(', ')}. Select one with npm run reinstall -- <device-serial>.`);
}

async function waitForDevice() {
  const requested = process.argv[2] || env.ANDROID_SERIAL;
  let devices = [];

  for (let attempt = 0; attempt < 20; attempt++) {
    devices = readDevices();
    const selected = chooseDevice(devices, requested);

    if (selected) return selected;

    if (!attempt) console.log('Waiting for ADB to detect an authorized Android device…');
    await delay(500);
  }

  const detected = devices.map(device => `${device.serial} (${device.state})`).join(', ') || 'none';
  const selection = requested ? `Selected device ${requested} is not ready. ` : '';
  throw new Error(`${selection}ADB detected: ${detected}. Unlock the phone and accept USB debugging authorization. Check adb devices -l${env.ANDROID_SERIAL ? ' and ANDROID_SERIAL' : ''}.`);
}

try {
  const serial = await waitForDevice();
  console.log('Building and starting the Piop debug daemon…');
  run(process.execPath, ['run', 'daemon:dev:restart']);
  const connection = JSON.parse(run(process.execPath, ['scripts/mobile-debug-connection.mjs'], true));
  const hostUrl = wirelessAddress(connection);
  console.log(`Rebuilding Piop for ${serial}…`);
  run(process.execPath, ['run', 'android:build']);
  run(adb, ['-s', serial, 'install', '-r', join(root, 'clients/android/app/build/outputs/apk/debug/app-debug.apk')]);
  run(adb, ['-s', serial, 'shell', 'am', 'start', '-S', '-n', 'dev.pi.mobile/.MainActivity', '--es', 'piopHostUrl', hostUrl]);
  console.log('Piop reinstalled and opened. App data preserved.');
  console.log(`Connected wirelessly through Tailscale: ${hostUrl}`);
  console.log('Daemon controls: bun run daemon:dev:stop | bun run daemon:dev:restart');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
