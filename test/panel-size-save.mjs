export async function savePanelSize(page, key, value, change) {
  await page.evaluate(({ key, value }) => {
    const put = IDBObjectStore.prototype.put;
    let finish;
    const saved = new Promise(resolve => { finish = resolve; });
    const timer = setTimeout(() => finish('Panel size was not saved'), 10000);
    window.panelSizeSave = {
      saved,
      restore() { clearTimeout(timer); IDBObjectStore.prototype.put = put; },
    };
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.transaction.db.name === 'piop-panel-sizes' && this.name === 'sizes' && args[1] === key && args[0] === value) {
        this.transaction.addEventListener('complete', () => finish(null), { once: true });
        this.transaction.addEventListener('abort', () => finish(this.transaction.error?.message ?? 'Panel size write failed'), { once: true });
      }
      return request;
    };
  }, { key, value });
  try {
    await change();
    const error = await page.evaluate(() => window.panelSizeSave.saved);
    if (error) throw new Error(error);
  } finally {
    await page.evaluate(() => { window.panelSizeSave.restore(); delete window.panelSizeSave; });
  }
}
