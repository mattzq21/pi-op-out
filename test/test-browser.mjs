import { chromium } from 'playwright-core';

/** The engine of the browser tests: PIOP_TEST_BROWSER=webkit runs them on WebKitGTK (MiniBrowser through WebKitWebDriver on Xvfb), otherwise on Chromium. */
export const testBrowserName = process.env.PIOP_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';

/** The skip reason of tests that need touch input: Xvfb has no touch device and WebKitGTK's WebDriver has no touch pointer. */
export const noTouchInput = testBrowserName === 'webkit' && 'WebKitGTK on the test screen has no touch input';

/** Launches the test browser. executablePath and args apply to Chromium. */
export async function launchTestBrowser({ executablePath, args = [] } = {}) {
  if (testBrowserName === 'webkit') return (await import('./webkit-browser.mjs')).launchWebKit();
  return chromium.launch({ executablePath: executablePath ?? process.env.CHROME_BIN ?? chromium.executablePath(), headless: true, args });
}
