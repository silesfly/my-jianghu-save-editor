'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const Codec = require('../src/myjh-codec.js');

function resolvePlaywright() {
  const candidates = [
    'playwright',
    '/home/jiyoung/.local/lib/node_modules/@playwright/mcp/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
    path.join(os.homedir(), '.npm-global/lib/node_modules/playwright'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* next */ }
  }
  throw new Error('playwright not found in any candidate path');
}

const HANZI_KANA = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/;

async function visitAllTabs(page) {
  const tabs = ['overview', 'role', 'items', 'martials', 'npcs', 'raw'];
  for (const tab of tabs) {
    await page.click(`#tab-btn-${tab}`);
    const hidden = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.hidden : null;
    }, `#panel-${tab}`);
    assert.strictEqual(hidden, false, `#panel-${tab} should be visible`);
  }
}

async function modeA(browser, distPath) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const badUrls = [];

  page.on('pageerror', (err) => pageErrors.push(String((err && err.message) || err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.route('**/*', (route, request) => {
    const url = request.url();
    if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    badUrls.push(url);
    return route.abort();
  });

  const fileUrl = 'file://' + distPath.split(path.sep).join('/');
  await page.goto(fileUrl, { waitUntil: 'load' });

  await page.click('#btn-demo');
  await page.waitForFunction(() => {
    const c = document.querySelector('#input-coin');
    return c && c.value === '1500';
  });

  await visitAllTabs(page);

  await page.click('#tab-btn-items');
  const beforeItemCount = await page.evaluate(() => document.querySelectorAll('#items-tbody tr').length);

  await page.click('#btn-add-item');
  await page.waitForFunction(() => {
    const d = document.querySelector('#catalog-dialog');
    return d && d.open === true;
  });

  await page.fill('#catalog-search-input', '경험단');
  await page.waitForFunction(() => !!document.querySelector('#catalog-results-body button[data-add-id]'));
  await page.click('#catalog-results-body button[data-add-id]');
  await page.click('#catalog-dialog form[method="dialog"] button');
  await page.waitForFunction(() => !document.querySelector('#catalog-dialog').open);

  const afterItemCount = await page.evaluate(() => document.querySelectorAll('#items-tbody tr').length);
  assert.ok(afterItemCount > beforeItemCount, `item count should increase (${beforeItemCount} -> ${afterItemCount})`);

  await page.click('#tab-btn-overview');
  await page.click('#preset-rich_resources');
  await page.waitForFunction(() => {
    const coin = document.querySelector('#input-coin');
    const silver = document.querySelector('#input-currency-silver');
    return coin && silver && Number(coin.value) >= 9999999 && Number(silver.value) >= 999999;
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-download'),
  ]);
  const dlPath = await download.path();
  assert.ok(dlPath, 'download path missing');
  const downloadedBytes = fs.readFileSync(dlPath);
  assert.strictEqual(Codec.validate(downloadedBytes).ok, true);
  assert.ok(Codec.parse(downloadedBytes).coin >= 9999999);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const hanziMatch = bodyText.match(HANZI_KANA);
  assert.strictEqual(hanziMatch, null, `unexpected Hanzi/Kana in body: ${hanziMatch && hanziMatch[0]}`);
  assert.ok(!bodyText.includes('실험적'), 'body must not include "실험적"');

  assert.strictEqual(pageErrors.length, 0, `pageerrors: ${JSON.stringify(pageErrors)}`);
  assert.strictEqual(consoleErrors.length, 0, `console errors: ${JSON.stringify(consoleErrors)}`);
  assert.strictEqual(badUrls.length, 0, `external network requests: ${JSON.stringify(badUrls)}`);

  await context.close();
}

async function modeB(browser, repoRoot) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myjh-e2e-'));
  let server = null;
  let context = null;
  try {
    const demoSaveBytes = Buffer.from(Codec.createDemoSave());
    const savePath = path.join(tmpDir, 'Save.sav');
    fs.writeFileSync(savePath, demoSaveBytes);

    server = spawn('python3', ['myjh_editor.py', 'serve', '--port', '0', '--no-browser', '--save-dir', tmpDir], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const portRegex = /\[서버 시작\]\s+http:\/\/127\.0\.0\.1:(\d+)\//;
    const serverUrl = await new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(`server start timeout. stdout=${out} stderr=${err}`)); }
      }, 15000);
      server.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
        const m = out.match(portRegex);
        if (m && !settled) {
          settled = true;
          clearTimeout(t);
          resolve(`http://127.0.0.1:${m[1]}/`);
        }
      });
      server.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
      server.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          reject(new Error(`server exited early code=${code} stderr=${err}`));
        }
      });
    });

    context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String((err && err.message) || err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(serverUrl, { waitUntil: 'load' });

    await page.waitForFunction(() => {
      const sel = document.querySelector('#slot-select');
      return sel && sel.options && sel.options.length > 1;
    });

    await page.evaluate(() => {
      const sel = document.querySelector('#slot-select');
      const target = Array.from(sel.options).find((o) => o.value && o.value.endsWith('Save.sav'));
      if (target) {
        sel.value = target.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    await page.waitForFunction(() => {
      const c = document.querySelector('#input-coin');
      return c && String(c.value) === '1500';
    });

    await page.fill('#input-coin', '7654321');
    await page.evaluate(() => {
      const c = document.querySelector('#input-coin');
      c.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await page.click('#btn-save-host');
    await page.waitForFunction(() => {
      const dirty = document.querySelector('#dirty-badge');
      return dirty && dirty.classList.contains('hidden');
    });

    const newBytes = fs.readFileSync(savePath);
    assert.strictEqual(Codec.validate(newBytes).ok, true);
    assert.strictEqual(Codec.parse(newBytes).coin, 7654321);

    const files = fs.readdirSync(tmpDir);
    const backupFile = files.find((f) => /^Save\.sav\.backup-.*\.bak$/.test(f));
    assert.ok(backupFile, `backup file missing in ${files.join(', ')}`);
    const backupBytes = fs.readFileSync(path.join(tmpDir, backupFile));
    assert.strictEqual(Buffer.compare(backupBytes, demoSaveBytes), 0);

    assert.strictEqual(pageErrors.length, 0, `modeB pageerrors: ${JSON.stringify(pageErrors)}`);
    assert.strictEqual(consoleErrors.length, 0, `modeB consoleErrors: ${JSON.stringify(consoleErrors)}`);
    await context.close();
    context = null;
  } finally {
    if (context) {
      try { await context.close(); } catch (_) {}
    }
    if (server && !server.killed) {
      try { server.kill('SIGTERM'); } catch (_) {}
      await new Promise((resolve) => {
        server.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function resolveChromiumExecutable(chromium) {
  try {
    const def = chromium.executablePath();
    if (def && fs.existsSync(def)) return undefined;
  } catch (_) {}
  const cacheDir = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cacheDir)) {
    for (const entry of fs.readdirSync(cacheDir).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const p = path.join(cacheDir, entry, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const sysPath of ['/usr/bin/google-chrome', '/opt/google/chrome/chrome']) {
    if (fs.existsSync(sysPath)) return sysPath;
  }
  return undefined;
}

(async () => {
  const { chromium } = resolvePlaywright();
  const repoRoot = path.resolve(__dirname, '..');
  const distPath = path.join(repoRoot, 'dist', 'MyJianghuSaveEditor-v1.1.html');
  assert.ok(fs.existsSync(distPath), `dist file missing: ${distPath}`);

  const executablePath = resolveChromiumExecutable(chromium);
  const browser = await chromium.launch(Object.assign({ headless: true }, executablePath ? { executablePath } : {}));
  let failures = 0;
  try {
    try {
      await modeA(browser, distPath);
      console.log('[PASS] Mode A (offline file://)');
    } catch (e) {
      failures++;
      console.error('[FAIL] Mode A (offline file://):', (e && e.stack) || e);
    }
    try {
      await modeB(browser, repoRoot);
      console.log('[PASS] Mode B (loopback HTTP server)');
    } catch (e) {
      failures++;
      console.error('[FAIL] Mode B (loopback HTTP server):', (e && e.stack) || e);
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  if (failures === 0) {
    console.log('Passed 2/2');
    process.exit(0);
  } else {
    console.error(`Passed ${2 - failures}/2`);
    process.exit(1);
  }
})().catch((err) => {
  console.error((err && err.stack) || err);
  process.exit(1);
});
