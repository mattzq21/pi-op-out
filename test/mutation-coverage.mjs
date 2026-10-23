import { writeFileSync } from 'node:fs';

globalThis.__stryker__ = {
  activeMutant: process.env.__STRYKER_ACTIVE_MUTANT__,
  currentTestId: process.env.PIOP_MUTATION_TEST,
};

const output = process.env.PIOP_MUTATION_COVERAGE;

if (output) process.once('exit', () => {
  writeFileSync(output, JSON.stringify(globalThis.__stryker__.mutantCoverage ?? { static: {}, perTest: {} }));
});
