import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div class="session-scroll" style="height:200px;overflow:auto"><section class="project reorderable"><div class="project-heading"><button class="project-label">Project</button></div>' + Array.from({ length: 20 }, (_, i) => `<div class="session-item reorderable"><button class="session-main">Chat ${i}</button></div>`).join('') + '</section></div>');
  await page.addStyleTag({ content: await readFile('src/styles.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('src/mobile.css', 'utf8') });
  const cdp = await page.context().newCDPSession(page);

  for (const selector of ['.session-main', '.project-label']) {
    await page.locator('.session-scroll').evaluate(el => { el.scrollTop = 0; });
    const box = await page.locator(selector).first().boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });

    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 15 }] });
      await page.waitForTimeout(20);
    }

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(200);
    const top = await page.locator('.session-scroll').evaluate(el => el.scrollTop);
    console.log(`${selector}: scrollTop=${top}`);
    assert.ok(top > 20, `swiping over ${selector} must scroll the sidebar`);
  }
} finally { await browser.close(); }
