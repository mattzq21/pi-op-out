import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const fixtureHome = process.env.PIOP_TEST_HOME;

if (!fixtureHome) throw new Error('The E2E Node home override requires PIOP_TEST_HOME');

os.homedir = () => fixtureHome;

syncBuiltinESMExports();
