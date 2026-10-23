import { daemonExecutable } from './harness';

delete process.env.PIOP_TEST_DAEMON_EXECUTABLE;
console.log(await daemonExecutable());
