const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const fixture = `<!doctype html><html><head></head><body>
  <p id="text">NATIVE_TEXT</p>
  <button id="copy">Copy</button>
  <button id="copy-preserve">Copy without changing selection</button>
  <div id="virtual" tabindex="0">Virtual editor</div>
  <div id="editable" contenteditable="true">EDITABLE_TEXT</div>
  <textarea id="input">INPUT_TEXT</textarea>
  <script>
    window.copyMode = 'native';
    document.querySelector('#copy').onclick = () => document.execCommand('copy');
    document.querySelector('#copy-preserve').onmousedown = e => e.preventDefault();
    document.querySelector('#copy-preserve').onclick = () => document.execCommand('copy');
    window.addEventListener('copy', e => {
      if (copyMode === 'capture') {
        e.preventDefault();
        e.clipboardData.setData('text/plain', 'WINDOW_HIJACKED');
      }
    }, true);
    window.addEventListener('contextmenu', e => {
      if (copyMode === 'capture') e.preventDefault();
    }, true);
    document.addEventListener('copy', e => {
      if (copyMode === 'custom') {
        window.customCopyCount = (window.customCopyCount || 0) + 1;
        e.preventDefault();
        e.clipboardData.setData('text/plain', 'GENERATED_DATA');
      }
    });
    document.querySelector('#virtual').addEventListener('keydown', e => {
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        navigator.clipboard.writeText('EDITOR_DATA');
      }
    });
  </script></body></html>`;

test('real extension copy compatibility and site settings', { timeout: 60000 }, async t => {
  const profile = await mkdtemp(path.join(tmpdir(), 'enable-copy-test-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      executablePath: process.env.CHROMIUM_PATH || undefined,
      headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const restricted = await readFile(path.join(root, 'test-page.html'), 'utf8');
    await context.route('https://**/*', route => route.fulfill({
      contentType: 'text/html',
      body: route.request().url().endsWith('/restricted') ? restricted : fixture,
    }));
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', event => worlds.push(event.context));
    await cdp.send('Runtime.enable');
    await page.goto('https://copy.test/first');
    const world = worlds.find(w => w.origin.startsWith('chrome-extension://'));
    assert.ok(world, 'The real extension content script must be loaded');
    const extensionId = (await cdp.send('Runtime.evaluate', {
      expression: 'chrome.runtime.id', contextId: world.id, returnByValue: true,
    })).result.value;
    let popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // A background target preserves the web tab as the active tab, as an
    // extension action popup does, while loading the real popup unchanged.
    const openPopup = async target => {
      await popup.close();
      await target.bringToFront();
      const opened = context.waitForEvent('page');
      await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html`, background: true });
      popup = await opened;
      await popup.waitForFunction(() => !document.querySelector('#toggle').disabled);
    };
    const key = 'enable-copy:site:https://copy.test';
    const setEnabled = async enabled => {
      await popup.evaluate(async ({ key, enabled }) => {
        await chrome.storage.local.set({ [key]: enabled });
      }, { key, enabled });
      await page.waitForFunction(enabled => Boolean(document.getElementById('__enable_copy_style__')) === enabled, enabled);
    };
    const clipboard = target => target.evaluate(() => navigator.clipboard.readText());
    const reset = async (mode = 'native') => {
      await page.bringToFront();
      await page.evaluate(async mode => {
        window.copyMode = mode;
        document.activeElement?.blur();
        window.getSelection().removeAllRanges();
        await navigator.clipboard.writeText('SENTINEL');
      }, mode);
    };
    const select = async (target, selector) => target.evaluate(selector => {
      const element = document.querySelector(selector);
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }, selector);

    await t.test('legacy global enabled does not enable unconfigured sites', async () => {
      await popup.evaluate(() => chrome.storage.local.set({ enabled: true }));
      await page.reload();
      await openPopup(page);
      assert.equal(await popup.locator('#toggle').isChecked(), false);
      assert.equal(await page.locator('#__enable_copy_style__').count(), 0);
    });

    await t.test('window capture restrictions follow first enable and repeated toggles', async () => {
      for (const enabled of [false, true, false, true]) {
        await setEnabled(enabled);
        await reset('capture');
        await select(page, '#text');
        await page.keyboard.press('Control+c');
        assert.equal(await clipboard(page), enabled ? 'NATIVE_TEXT' : 'WINDOW_HIJACKED');
        assert.equal(await page.evaluate(() => document.querySelector('#text').dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        )), enabled);
      }
    });

    await t.test('copy buttons preserve selection without exempting subsequent body copies', async () => {
      for (const enabled of [false, true]) {
        await setEnabled(enabled);
        await reset('custom');
        await select(page, '#text');
        await page.click('#copy-preserve');
        assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
        assert.equal(await page.evaluate(() => getSelection().toString()), 'NATIVE_TEXT');
        assert.equal(await clipboard(page), 'GENERATED_DATA');

        await page.keyboard.press('Control+c');
        assert.equal(await clipboard(page), enabled ? 'NATIVE_TEXT' : 'GENERATED_DATA');

        const customCopyCount = await page.evaluate(() => {
          window.customCopyCount = 0;
          document.querySelector('#copy-preserve').click();
          document.execCommand('copy');
          return window.customCopyCount;
        });
        assert.equal(customCopyCount, enabled ? 1 : 2);
        assert.equal(await clipboard(page), enabled ? 'NATIVE_TEXT' : 'GENERATED_DATA');
      }
    });

    for (const enabled of [false, true]) {
      await t.test(`copy compatibility with site enabled=${enabled}`, async () => {
        await setEnabled(enabled);
        await reset();
        await select(page, '#text');
        await page.keyboard.press('Control+c');
        assert.equal(await clipboard(page), 'NATIVE_TEXT');

        await reset('custom');
        await page.click('#copy');
        assert.equal(await clipboard(page), 'GENERATED_DATA');

        await reset();
        await page.focus('#virtual');
        await page.keyboard.press('Control+c');
        assert.equal(await clipboard(page), 'EDITOR_DATA');

        await reset('custom');
        await page.focus('#editable');
        await select(page, '#editable');
        await page.keyboard.press('Control+c');
        assert.equal(await clipboard(page), 'GENERATED_DATA');

        await reset('custom');
        await page.locator('#input').selectText();
        await page.keyboard.press('Control+c');
        assert.equal(await clipboard(page), 'GENERATED_DATA');
      });
    }

    await t.test('site scope, existing tabs, cross-origin frames and reload', async () => {
      const second = await context.newPage();
      await second.goto('https://copy.test/second');
      const other = await context.newPage();
      await other.goto('https://other.test/');
      await second.evaluate(() => {
        const iframe = document.createElement('iframe');
        iframe.src = 'https://embedded.test/';
        document.body.appendChild(iframe);
      });
      await second.frameLocator('iframe').locator('#text').waitFor();
      const embedded = second.frames().find(frame => frame.url().startsWith('https://embedded.test/'));
      await second.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      await embedded.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      assert.equal(await other.locator('#__enable_copy_style__').count(), 0);
      await setEnabled(false);
      await second.waitForSelector('#__enable_copy_style__', { state: 'detached' });
      await embedded.waitForSelector('#__enable_copy_style__', { state: 'detached' });
      await setEnabled(true);
      await second.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      await embedded.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      await page.reload();
      await page.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      await second.close();
      await other.close();
    });

    await t.test('original restricted page is unlocked and restored on disable', async () => {
      await page.goto('https://copy.test/restricted');
      await page.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      await page.bringToFront();
      const expected = await page.locator('.card p').first().textContent();
      await select(page, '.card p');
      await page.keyboard.press('Control+c');
      assert.equal(await clipboard(page), expected);
      assert.equal(await page.evaluate(() => {
        return document.querySelector('.card p').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      }), true);
      await setEnabled(false);
      await page.keyboard.press('Control+c');
      assert.match(await page.locator('#log').textContent(), /快捷键/);
    });

    await t.test('popup toggles the current site and tracks storage changes', async () => {
      await popup.locator('.switch').click();
      await page.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      await popup.locator('.switch').click();
      await page.waitForSelector('#__enable_copy_style__', { state: 'detached' });
      await setEnabled(true);
      await popup.waitForFunction(() => document.querySelector('#toggle').checked);
      await popup.evaluate(key => chrome.storage.local.remove(key), key);
      await page.waitForSelector('#__enable_copy_style__', { state: 'detached' });
    });
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
