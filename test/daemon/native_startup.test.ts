import { expect, test } from 'bun:test';
import { startDaemon } from './harness';

for (let attempt = 1; attempt <= 3; attempt++) {
  test.concurrent(`native Pi startup answers an agent request without a readiness workaround (${attempt}/3)`, async () => {
    const daemon = await startDaemon();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const chat = await daemon.invoke('create_temporary_chat');
          const runtimeId = 'native-startup';
          expect(await daemon.invoke('start_pi', {
            runtimeId, clientId: 'native-startup', cwd: chat.cwd, sessionId: chat.sessionId,
          })).toMatchObject({ owned: true });
          await daemon.invoke('pi_command', { runtimeId, command: { type: 'select_agent', agent: 'general' } });
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native Pi startup did not answer within 15 seconds')), 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await daemon.stop();
    }
  }, 60_000);
}
