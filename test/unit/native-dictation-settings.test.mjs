import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeFileCommand } from '../native-file-command.mjs';

const base = { keybindings: { openSettings: 'Ctrl+,' }, debugMode: false };

/** Saves dictation preferences in the desktop app and returns the dictation status once the engine check ends. */
async function dictation(t) {
  const native = await nativeFileCommand(t, { desktop: true });
  let saved = base;
  return {
    home: native.directory,
    native,
    async save(preferences) {
      const settings = { ...base, ...preferences };
      await native.invoke('save_client_settings', { settings, baseline: saved });
      saved = settings;
    },
    async status() {
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = await native.invoke('plugin:dictation|dictation_configuration');
        if (!status.loading) return status;
        await sleep(25);
      }
      throw new Error('The dictation engine check did not finish');
    },
    async configure(preferences) {
      await this.save(preferences);
      return this.status();
    },
  };
}

test('a settings save reaches dictation while another event is being dispatched', async t => {
  const speech = await dictation(t);
  const models = join(speech.home, 'models');
  await mkdir(models);
  await writeFile(join(models, 'whisper.bin'), '');
  assert.equal((await speech.configure({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/models/missing.gguf' })).error, `The model file ${models}/missing.gguf does not exist`);
  await speech.native.invoke('hold_event_dispatch');
  try {
    await speech.save({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/models/whisper.bin' });
    assert.equal((await speech.status()).error, `The model file ${models}/whisper.bin is not a .gguf file. Transcribe.cpp needs a .gguf model.`);
  } finally {
    await speech.native.invoke('release_event_dispatch');
  }
});

test('dictation settings that cannot work say what to fix', async t => {
  const speech = await dictation(t);
  const models = join(speech.home, 'models');
  await mkdir(models);
  await writeFile(join(models, 'whisper.bin'), '');
  await writeFile(join(models, 'whisper.gguf'), '');
  const error = async preferences => (await speech.configure(preferences)).error;
  assert.equal(await error({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/models/missing.gguf' }), `The model file ${models}/missing.gguf does not exist`);
  assert.equal(await error({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/models/whisper.bin' }), `The model file ${models}/whisper.bin is not a .gguf file. Transcribe.cpp needs a .gguf model.`);
  assert.equal(await error({ dictationEngine: 'needle', dictationModelPath: '~/models/whisper.gguf' }), `The model file ${models}/whisper.gguf is not a .cact file. Needle needs a .cact model.`);
  assert.equal(await error({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/models/whisper.gguf', dictationArgs: '--lang en' }), 'Unknown dictation argument --lang. The only argument is --language <code>.');
  assert.equal(await error({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/models/whisper.gguf', dictationArgs: '--language' }), 'The argument --language needs a language code, for example --language en');
  assert.equal(await error({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/models/whisper.gguf', dictationEngines: [{ engine: 'transcribe.cpp', path: '~/bin/python', models: [] }] }), `The program ${speech.home}/bin/python does not exist`);
});

test('a speech program without the engine installed is named in the error', async t => {
  const speech = await dictation(t);
  const bin = join(speech.home, 'bin');
  await mkdir(bin);
  await writeFile(join(speech.home, 'model.gguf'), '');
  await writeFile(join(speech.home, 'model.cact'), '');
  await writeFile(join(bin, 'python3'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(join(bin, 'needle'), '#!/bin/sh\necho needle\n', { mode: 0o755 });
  const transcribe = await speech.configure({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/model.gguf', dictationEngines: [{ engine: 'transcribe.cpp', path: '~/bin/python3', models: [] }] });
  assert.deepEqual([transcribe.enabled, transcribe.error], [false, `${bin}/python3: ${bin}/python3 does not have Transcribe.cpp installed`]);
  const needle = await speech.configure({ dictationEngine: 'needle', dictationModelPath: '~/model.cact', dictationEngines: [{ engine: 'needle', path: '~/bin/needle', models: [] }] });
  assert.equal(needle.error, `${bin}/needle: The needle program does not name a Python interpreter`);
});

/** A python3 that has the engine installed. As the worker it reads all audio, then runs the given shell lines. */
const fakePython = worker => `#!/bin/sh
case "$2" in *find_spec*) exit 0 ;; esac
cat > /dev/null
${worker}
`;

test('a working speech engine turns dictation on with its languages, and a failing one shows its error', async t => {
  const speech = await dictation(t);
  await writeFile(join(speech.home, 'model.gguf'), '');
  const python = join(speech.home, 'python3');
  const configure = () => speech.configure({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/model.gguf', dictationArgs: '--language=EN', dictationEngines: [{ engine: 'transcribe.cpp', path: python, models: [] }] });
  await writeFile(python, fakePython(`echo '{"type":"ready","languages":["en","fr"],"detect":false}'
echo '{"type":"final","text":""}'`), { mode: 0o755 });
  assert.deepEqual(await configure(), { enabled: true, loading: false, engine: 'transcribe.cpp', executable: python, language: 'en', languages: ['en', 'fr'], detectLanguage: false });
  await writeFile(python, fakePython(`echo 'Traceback (most recent call last):' >&2
echo 'RuntimeError: language en is not in this model' >&2
exit 1`), { mode: 0o755 });
  await speech.configure({ dictationEngine: 'transcribe.cpp', dictationModelPath: '~/model.gguf' });
  const failed = await configure();
  assert.deepEqual([failed.enabled, failed.error], [false, 'The speech engine failed: RuntimeError: language en is not in this model']);
});
