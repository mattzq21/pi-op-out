import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const SUPPORTED_PI_VERSION = '1.5.0';

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES';
}

function executablePath(executable) {
  try { return realpathSync(executable); }
  catch (error) { if (missing(error)) throw new Error(`Pi was not found at ${executable}`); throw error; }
}

function packageAt(directory) {
  const file = join(directory, 'package.json');
  let body;

  try { body = readFileSync(file, 'utf8'); }
  catch (error) { if (missing(error)) return undefined; throw error; }

  try { return JSON.parse(body); }
  catch (error) { throw new Error(`Could not read ${file}: ${error.message}`); }
}

function piInstallation(executable) {
  const entry = executablePath(executable);

  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    const metadata = packageAt(directory);

    if (metadata?.name === PI_PACKAGE) {
      if (typeof metadata.version !== 'string') throw new Error(`Pi at ${directory} has no version`);

      return { root: directory, version: metadata.version };
    }

    if (dirname(directory) === directory) throw new Error(`${entry} is not part of a ${PI_PACKAGE} installation`);
  }
}

function supportedPi(executable: string): { root: string; version: string } {
  const pi = piInstallation(executable);

  if (pi.version !== SUPPORTED_PI_VERSION) {
    throw new Error(`Piop needs Pi ${SUPPORTED_PI_VERSION}, but found Pi ${pi.version} at ${pi.root}`);
  }

  return pi;
}

export { SUPPORTED_PI_VERSION, supportedPi };
