// Record rrweb from a Playwright page (for example test/app-browser-fixture.mjs appBrowser) into the skill's events.json format.
import fs from 'node:fs';
import { ensureBundles } from './bundles.mjs';
import * as PAGE from './page.mjs';
import { writeRecording } from './recording.mjs';

// The PAGE scripts are WebDriver script bodies that read `arguments` and `return`; run them the same way here.
const run = (page, body, args = []) => page.evaluate(({ body, args }) => new Function(body).apply(null, args), { body, args });

async function checked(promise) {
  const value = await promise;
  if (value && value.error) throw new Error('piop-rrweb: ' + value.error);
  return value;
}

/**
 * Starts recording the page. Returns { mark(label, payload), stop(outDir) }. stop writes events.json, geometry.json and
 * recording.json into outDir and returns a short summary. track lists selectors whose geometry is sampled.
 */
export async function recordPage(page, { track = [], mask = false, intervalMs = 20 } = {}) {
  if (!(await page.evaluate(() => typeof rrwebRecord !== 'undefined'))) await page.addScriptTag({ content: fs.readFileSync(ensureBundles({ quiet: true }).record, 'utf8') });
  await checked(run(page, PAGE.START, [{ mask, track, intervalMs }]));
  return {
    mark: (label, payload = {}) => checked(run(page, PAGE.MARK, [label, payload])),
    async stop(outDir) { return writeRecording(outDir, await checked(run(page, PAGE.STOP)), track); },
  };
}
