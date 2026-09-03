const { chromium } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const file = path.join(__dirname, 'workbench-capture.html');
  for (const mode of ['files', 'terminal']) {
    await page.goto(`${pathToFileURL(file).href}?mode=${mode}`, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(__dirname, 'assets', `08-workbench-${mode}-correct.png`), fullPage: false });
  }
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
