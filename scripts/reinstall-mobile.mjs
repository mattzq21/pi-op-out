import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const home = homedir();

const extension = process.platform === 'win32' ? '.exe' : '';

const env = { ...process.env, VITE_PIOP_DEBUG: "true" };

const localProperties = join(root, 'android/local.properties');

const configuredSdk = existsSync(localProperties)
  ? readFileSync(localProperties, 'utf8').match(/^sdk\.dir=(.+)$/m)?.[1].trim().replace(/\\([\\: ])/g, '$1')
  : undefined;

const sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, configuredSdk, join(home, 'Android/Sdk'), join(home, 'Library/Android/sdk')]
  .find((path) => path && existsSync(join(path, `platform-tools/adb${extension}`)));

const adb = sdk ? join(sdk, `platform-tools/adb${extension}`) : `adb${extension}`;

if (sdk) env.ANDROID_HOME = sdk;

if (!env.JAVA_HOME) {
  const java = [join(home, 'Applications/android-studio/jbr'), '/opt/android-studio/jbr', '/Applications/Android Studio.app/Contents/jbr/Contents/Home']
    .find((path) => existsSync(join(path, `bin/java${extension}`)));

  if (java) env.JAVA_HOME = java;
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });

  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);

  if (result.status !== 0) throw new Error(`${command} failed${capture ? `: ${result.stderr.trim()}` : ''}`);

  return result.stdout;
}

try {
  const devices = run(adb, ['devices'], true).split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(\S+)\s+device$/);

    return match ? [match[1]] : [];
  });

  const serial = process.argv[2] || env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : undefined);

  if (!serial || !devices.includes(serial)) throw new Error('Connect and authorize one Android device, or select one with npm run reinstall -- <device-serial>.');
  console.log('Building and starting the Piop debug daemon…');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'daemon:dev:restart']);
  const connection = JSON.parse(run(process.execPath, ['scripts/mobile-debug-connection.mjs'], true));
  const debugUrl = new URL(connection.url);
  debugUrl.hostname = '127.0.0.1';
  console.log(`Rebuilding Piop for ${serial}…`);
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'android:build']);
  run(adb, ['-s', serial, 'install', '-r', join(root, 'android/app/build/outputs/apk/debug/app-debug.apk')]);
  run(adb, ['-s', serial, 'reverse', `tcp:${debugUrl.port}`, `tcp:${debugUrl.port}`]);
  run(adb, ['-s', serial, 'shell', 'am', 'start', '-S', '-n', 'dev.pi.mobile/.MainActivity', '--es', 'piopDebugUrl', debugUrl.href]);
  console.log('Piop reinstalled and opened. App data preserved.');
  console.log('Daemon controls: npm run daemon:dev:stop | npm run daemon:dev:restart');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
