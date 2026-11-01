import { chromium } from 'playwright-core';

export const testBrowserName = process.env.PIOP_TEST_BROWSER === 'chromium' ? 'chromium' : 'webkit';

export const chromiumOnly = 'chromium';

export async function launchTestBrowser({ engine = testBrowserName, executablePath, args = [] } = {}) {
  if (engine === 'webkit') return (await import('./webkit-browser.mjs')).launchWebKit();
  const browser = await chromium.launch({ executablePath: executablePath ?? process.env.CHROME_BIN ?? chromium.executablePath(), headless: true, args });
  await readCustomElementValues(browser);
  return browser;
}

let customValuesRead = false;

async function readCustomElementValues(browser) {
  if (customValuesRead) return;
  const page = await browser.newPage();
  const prototype = Object.getPrototypeOf(page.locator('body'));
  await page.close();
  const inputValue = prototype.inputValue;
  prototype.inputValue = async function (options) {
    const value = await this.evaluate(node => node.nodeName.includes('-') && typeof node.value === 'string' ? node.value : undefined, undefined, options);
    return value ?? inputValue.call(this, options);
  };
  customValuesRead = true;
}
