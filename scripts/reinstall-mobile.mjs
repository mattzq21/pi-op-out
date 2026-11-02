import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const home = homedir();

const args = process.argv.slice(2);

const release = args.includes('--release');

const env = { ...process.env, VITE_PIOP_DEBUG: String(!release) };

const localPropertiesPath = join(root, 'clients/android/local.properties');

const localProperties = new Map(existsSync(localPropertiesPath)
  ? readFileSync(localPropertiesPath, 'utf8').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*([^#!\s][^=:]*?)\s*[=:]\s*(.*)$/);

    return match ? [[match[1], match[2].trim().replace(/\\(.)/g, '$1')]] : [];
  })
  : []);

const sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, localProperties.get('sdk.dir'), join(home, 'Android/Sdk')]
  .find((path) => path && existsSync(join(path, 'platform-tools/adb')));

const adb = sdk ? join(sdk, 'platform-tools/adb') : 'adb';

if (sdk) env.ANDROID_HOME = sdk;

function run(command, commandArgs, capture = false, cwd = root, extraEnv = {}) {
  const result = spawnSync(command, commandArgs, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });

  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);

  if (result.status !== 0) throw new Error(`${command} failed${capture ? `: ${result.stderr.trim()}` : ''}`);

  return result.stdout;
}

function apksigner() {
  const tools = sdk ? join(sdk, 'build-tools') : undefined;
  const version = tools && existsSync(tools)
    ? readdirSync(tools).filter(name => existsSync(join(tools, name, 'apksigner'))).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    : undefined;

  if (!version) throw new Error('Could not find apksigner in the Android SDK build-tools.');

  return join(tools, version, 'apksigner');
}

function releaseKey() {
  const names = ['piop.release.storeFile', 'piop.release.storePassword', 'piop.release.keyAlias'];
  const missing = names.filter(name => !localProperties.get(name));

  if (missing.length) {
    throw new Error(`Set the release signing key in ${localPropertiesPath}:\n`
      + 'piop.release.storeFile=/path/to/piop-release.jks\npiop.release.storePassword=...\npiop.release.keyAlias=piop\npiop.release.keyPassword=... (optional, defaults to storePassword)\n'
      + `Missing: ${missing.join(', ')}\n`
      + 'Create a key with: keytool -genkeypair -keystore piop-release.jks -alias piop -keyalg RSA -keysize 4096 -validity 10000');
  }

  const store = resolve(dirname(localPropertiesPath), localProperties.get('piop.release.storeFile'));

  if (!existsSync(store)) throw new Error(`The release signing key file does not exist: ${store}`);

  return { store, alias: localProperties.get('piop.release.keyAlias'), storePassword: localProperties.get('piop.release.storePassword'), keyPassword: localProperties.get('piop.release.keyPassword') || localProperties.get('piop.release.storePassword') };
}

function buildRelease() {
  const key = releaseKey();
  run(process.execPath, ['run', 'android:sync']);
  run('./gradlew', ['assembleRelease'], false, join(root, 'clients/android'));
  const outputs = join(root, 'clients/android/app/build/outputs/apk/release');
  const signed = join(outputs, 'app-release-signed.apk');
  run(apksigner(), ['sign', '--ks', key.store, '--ks-key-alias', key.alias, '--ks-pass', 'env:PIOP_RELEASE_STORE_PASSWORD', '--key-pass', 'env:PIOP_RELEASE_KEY_PASSWORD', '--out', signed, join(outputs, 'app-release-unsigned.apk')], false, root, { PIOP_RELEASE_STORE_PASSWORD: key.storePassword, PIOP_RELEASE_KEY_PASSWORD: key.keyPassword });

  return signed;
}

function endpointKey(project) {
  let key = 0xcbf29ce484222325n;

  for (const byte of Buffer.from(project.replace(/\/+$/, '') + '/src-tauri')) key = BigInt.asUintN(64, (key ^ BigInt(byte)) * 0x100000001b3n);

  return key.toString(16).padStart(16, '0');
}

function servePort(key) {
  return 20000 + Number(BigInt('0x' + key) % 40000n);
}

function tailscale(commandArgs) {
  const result = spawnSync('tailscale', commandArgs, { cwd: root, env, encoding: 'utf8' });

  if (result.error) throw new Error(`Could not run tailscale: ${result.error.message}`);

  if (result.status !== 0) {
    const output = (result.stderr || result.stdout).trim();
    const access = /access denied|permission|operator/i.test(output) ? '\nAllow your user to change Tailscale Serve once with: sudo tailscale set --operator=$USER' : '';
    throw new Error(`tailscale ${commandArgs.join(' ')} failed: ${output}${access}`);
  }

  return result.stdout;
}

function serveStatus() {
  return JSON.parse(tailscale(['serve', 'status', '--json']) || '{}');
}

function worktreePorts() {
  const worktrees = run('git', ['worktree', 'list', '--porcelain'], true).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));

  return new Map(worktrees.map(path => { const key = endpointKey(path); return [key, servePort(key)]; }));
}

// Removes Serve ports that point to development daemons of deleted worktrees, or to an old port of a live worktree.
function removeStaleRoutes(configuration, key, port) {
  const live = worktreePorts();
  live.set(key, port);
  const developmentSocket = new RegExp(`^unix:${join(home, '.piop-dev', 'daemons').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([0-9a-f]{16})/tailscale\\.sock$`);

  for (const [address, site] of Object.entries(configuration.Web ?? {})) {
    const handlers = Object.entries(site.Handlers ?? {});
    const key = handlers.length === 1 && handlers[0][0] === '/' ? handlers[0][1].Proxy?.match(developmentSocket)?.[1] : undefined;
    const port = Number(address.slice(address.lastIndexOf(':') + 1));

    if (key && live.get(key) !== port) tailscale(['serve', `--https=${port}`, 'off']);
  }
}

function wirelessAddress(connection) {
  const target = `unix:${join(connection.runtime.daemonDirectory, 'tailscale.sock')}`;
  const key = basename(connection.runtime.daemonDirectory);

  if (!/^[0-9a-f]{16}$/.test(key)) throw new Error(`Unexpected development daemon directory: ${connection.runtime.daemonDirectory}`);
  const port = servePort(key);
  console.log(`Configuring wireless Tailscale access on port ${port}…`);
  removeStaleRoutes(serveStatus(), key, port);
  const current = serveStatus();
  const used = Object.entries(current.Web ?? {}).find(([address]) => address.endsWith(`:${port}`));

  if (used && used[1].Handlers?.['/']?.Proxy !== target) throw new Error(`Tailscale Serve port ${port} is already used by ${JSON.stringify(used[1].Handlers)}. Free it with: tailscale serve --https=${port} off`);

  if (!used && current.TCP?.[port]) throw new Error(`Tailscale Serve port ${port} is already used. Free it with: tailscale serve --tcp=${port} off`);
  tailscale(['serve', '--bg', `--https=${port}`, '--yes', target]);
  const route = Object.entries(serveStatus().Web ?? {}).find(([address, site]) => address.endsWith(`:${port}`) && site.Handlers?.['/']?.Proxy === target);

  if (!route) throw new Error('Could not find the rebuilt daemon’s Tailscale address.');

  return `wss://${route[0]}/`;
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

  if (ready.length > 1) throw new Error(`Multiple Android devices are ready: ${ready.map(device => device.serial).join(', ')}. Select one with bun run ${release ? 'reinstall:release' : 'reinstall'} <device-serial>.`);
}

async function waitForDevice() {
  const requested = args.find(arg => !arg.startsWith('--')) || env.ANDROID_SERIAL;
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

  if (release) {
    console.log(`Building the Piop release app for ${serial}…`);
    run(adb, ['-s', serial, 'install', '-r', buildRelease()]);
    run(adb, ['-s', serial, 'shell', 'am', 'start', '-S', '-n', 'dev.pi.mobile/.MainActivity']);
    console.log('Piop release reinstalled and opened. App data preserved.');
  } else {
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
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
