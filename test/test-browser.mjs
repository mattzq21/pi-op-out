import { chromium } from 'playwright-core';

/** The engine of the browser tests: WebKitGTK (MiniBrowser through WebKitWebDriver on Xvfb), or Chromium with PIOP_TEST_BROWSER=chromium. */
export const testBrowserName = process.env.PIOP_TEST_BROWSER === 'chromium' ? 'chromium' : 'webkit';

/**
 * The engine of tests that need touch input or a trusted file drop. Xvfb has no touch device, WebKitGTK's WebDriver has no touch pointer,
 * and WebKitGTK loses the files of a real drop (https://bugs.webkit.org/show_bug.cgi?id=323277), so these tests always run on Chromium.
 */
export const chromiumOnly = 'chromium';

/** Launches a test browser, by default of testBrowserName. executablePath and args apply to Chromium. */
export async function launchTestBrowser({ engine = testBrowserName, executablePath, args = [] } = {}) {
  if (engine === 'webkit') return (await import('./webkit-browser.mjs')).launchWebKit();
  const browser = await chromium.launch({ executablePath: executablePath ?? process.env.CHROME_BIN ?? chromium.executablePath(), headless: true, args });
  await readCustomElementValues(browser);
  return browser;
}

let customValuesRead = false;

/** locator.inputValue also reads the value of a custom element that has one, as the WebKit bridge does. The message box of the composer is such an element. */
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
