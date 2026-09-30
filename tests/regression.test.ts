import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext, Frame, Page } from 'playwright';

type CopyMode = 'native' | 'capture' | 'custom';

declare global {
  interface Window {
    copyMode: CopyMode;
    customCopyCount?: number;
    virtualSelectAll?: number;
    shadowContextMenuCount?: number;
  }
}

const root = path.resolve(import.meta.dirname, '..');
const extensionRoot = path.join(root, 'dist');
const fixture = `<!doctype html><html><head></head><body>
  <p id="text">NATIVE_TEXT</p>
  <button id="copy">Copy</button>
  <button id="copy-preserve">Copy without changing selection</button>
  <span id="role-copy" role="button">Custom copy button</span>
  <button id="copy-nested">Nested copy</button>
  <button id="copy-inner" hidden>Inner action</button>
  <div id="virtual" tabindex="0">Virtual editor</div>
  <div id="editable" contenteditable="true">EDITABLE_TEXT</div>
  <textarea id="input">INPUT_TEXT</textarea>
  <script>
    window.copyMode = 'native';
    document.querySelector('#copy').onclick = () => document.execCommand('copy');
    document.querySelector('#copy-preserve').onmousedown = e => e.preventDefault();
    document.querySelector('#copy-preserve').onclick = () => document.execCommand('copy');
    document.querySelector('#role-copy').onmousedown = e => e.preventDefault();
    document.querySelector('#role-copy').onclick = () => document.execCommand('copy');
    document.querySelector('#copy-nested').onmousedown = e => e.preventDefault();
    document.querySelector('#copy-nested').onclick = () => {
      document.querySelector('#copy-inner').click();
      document.execCommand('copy');
    };
    window.addEventListener('keydown', e => {
      if (copyMode === 'capture' && (e.ctrlKey || e.metaKey) && e.key === 'a') e.preventDefault();
    }, true);
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
      if (e.ctrlKey && e.key === 'a') {
        e.preventDefault();
        window.virtualSelectAll = (window.virtualSelectAll || 0) + 1;
      }
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        navigator.clipboard.writeText('EDITOR_DATA');
      }
    });
  </script></body></html>`;

test('real extension copy compatibility and site settings', { timeout: 60000 }, async t => {
  const profile = await mkdtemp(path.join(tmpdir(), 'enable-copy-test-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      headless: true,
      args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const browserContext = context;
    const errors: string[] = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const key = 'enable-copy:site:https://copy.test';
    await context.addInitScript(({ key }) => {
      if (location.protocol !== 'chrome-extension:') return;
      const scenario = new URLSearchParams(location.search).get('scenario');
      if (!scenario) return;
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      const set = chrome.storage.local.set.bind(chrome.storage.local);
      const writeAndObserve = async (enabled: boolean) => {
        const changed = new Promise<void>(resolve => {
          const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area !== 'local' || !Object.hasOwn(changes, key)) return;
            chrome.storage.onChanged.removeListener(listener);
            resolve();
          };
          chrome.storage.onChanged.addListener(listener);
        });
        await set({ [key]: enabled });
        await changed;
      };
      if (scenario === 'initial-read') {
        let firstRead = true;
        chrome.storage.local.get = (async (keys: string) => {
          const snapshot = await get(keys);
          if (firstRead) {
            firstRead = false;
            await writeAndObserve(false);
          }
          return snapshot;
        }) as typeof chrome.storage.local.get;
      } else if (scenario === 'save-superseded' || scenario === 'save-failed') {
        let firstWrite = true;
        chrome.storage.local.set = async values => {
          if (!firstWrite) return set(values);
          firstWrite = false;
          await writeAndObserve(true);
          if (scenario === 'save-failed') throw new Error('Simulated storage failure after an external update');
          await writeAndObserve(false);
        };
      }
    }, { key });
    const restricted = await readFile(path.join(root, 'test-page.html'), 'utf8');
    await context.route('https://**/*', route => route.fulfill({
      contentType: 'text/html',
      body: route.request().url().endsWith('/restricted') ? restricted : fixture,
    }));
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const worlds: { id: number; origin: string }[] = [];
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
    const openPopup = async (target: Page, scenario = '') => {
      await popup.close();
      await target.bringToFront();
      const opened = browserContext.waitForEvent('page');
      await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html?scenario=${scenario}`, background: true });
      popup = await opened;
      await popup.waitForFunction(() => !document.querySelector<HTMLInputElement>('#toggle')!.disabled);
    };
    const setEnabled = async (enabled: boolean) => {
      await popup.evaluate(async ({ key, enabled }) => {
        await chrome.storage.local.set({ [key]: enabled });
      }, { key, enabled });
      await page.waitForFunction(enabled => Boolean(document.getElementById('__enable_copy_style__')) === enabled, enabled);
    };
    const clipboard = (target: Page) => target.evaluate(() => navigator.clipboard.readText());
    const reset = async (mode: CopyMode = 'native') => {
      await page.bringToFront();
      await page.evaluate(async mode => {
        window.copyMode = mode;
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.getSelection()!.removeAllRanges();
        await navigator.clipboard.writeText('SENTINEL');
      }, mode);
    };
    const select = async (target: Page | Frame, selector: string) => target.evaluate(selector => {
      const element = document.querySelector(selector);
      const range = document.createRange();
      if (!element) throw new Error(`Missing fixture element: ${selector}`);
      range.selectNodeContents(element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
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
        assert.equal(await page.evaluate(() => document.querySelector('#text')!.dispatchEvent(
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
        assert.equal(await page.evaluate(() => document.activeElement!.tagName), 'BODY');
        assert.equal(await page.evaluate(() => getSelection()!.toString()), 'NATIVE_TEXT');
        assert.equal(await clipboard(page), 'GENERATED_DATA');

        await page.keyboard.press('Control+c');
        assert.equal(await clipboard(page), enabled ? 'NATIVE_TEXT' : 'GENERATED_DATA');

        const customCopyCount = await page.evaluate(() => {
          window.customCopyCount = 0;
          document.querySelector<HTMLButtonElement>('#copy-preserve')!.click();
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

    await t.test('select all works before there is a text selection', async () => {
      await setEnabled(true);
      await reset('capture');
      await page.keyboard.press('Control+a');
      assert.match(await page.evaluate(() => getSelection()!.toString()), /NATIVE_TEXT/);
    });

    await t.test('ARIA copy buttons retain their custom clipboard data', async () => {
      await setEnabled(true);
      await reset('custom');
      await select(page, '#text');
      await page.click('#role-copy');
      assert.equal(await clipboard(page), 'GENERATED_DATA');
      await page.keyboard.press('Control+c');
      assert.equal(await clipboard(page), 'NATIVE_TEXT');
    });

    await t.test('nested button clicks preserve custom copy only during dispatch', async () => {
      await setEnabled(true);
      await reset('custom');
      await select(page, '#text');
      await page.click('#copy-nested');
      assert.equal(await clipboard(page), 'GENERATED_DATA');
      await page.keyboard.press('Control+c');
      assert.equal(await clipboard(page), 'NATIVE_TEXT');
    });

    await t.test('focused custom widgets and shadow editors retain native interactions', async () => {
      await setEnabled(true);
      await reset();
      await page.focus('#virtual');
      await page.keyboard.press('Control+a');
      assert.equal(await page.evaluate(() => window.virtualSelectAll), 1);
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'shadow-editor';
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<textarea>SHADOW_INPUT</textarea>';
        document.body.appendChild(host);
        shadow.querySelector('textarea')!.focus();
        // Global handlers also receive events whose path omits the editor.
        window.addEventListener('contextmenu', () => { window.shadowContextMenuCount = 1; }, { once: true });
        document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      assert.equal(await page.evaluate(() => window.shadowContextMenuCount), 1);
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Control+c');
      assert.equal(await clipboard(page), 'SHADOW_INPUT');
      await page.evaluate(() => document.querySelector('#shadow-editor')!.remove());
    });

    await t.test('page-owned style IDs do not prevent enable or get removed on disable', async () => {
      await setEnabled(false);
      try {
        await page.evaluate(() => {
          const node = document.createElement('div');
          node.id = '__enable_copy_style__';
          node.dataset.pageOwned = 'true';
          document.body.appendChild(node);
        });
        await popup.evaluate(key => chrome.storage.local.set({ [key]: true }), key);
        await page.waitForSelector('style#__enable_copy_style__', { state: 'attached', timeout: 1500 });
        await popup.evaluate(key => chrome.storage.local.set({ [key]: false }), key);
        await page.waitForFunction(() => !document.querySelector('style#__enable_copy_style__'), null, { timeout: 1500 });
        assert.equal(await page.locator('[data-page-owned]').count(), 1);
      } finally {
        await popup.evaluate(key => chrome.storage.local.set({ [key]: false }), key);
        await page.evaluate(() => document.querySelector('[data-page-owned]')?.remove());
      }
    });

    await t.test('inherited-origin frames follow the top-level site setting', async () => {
      await setEnabled(true);
      const framed = await browserContext.newPage();
      try {
        await framed.goto('https://copy.test/inherited-frames');
        await framed.evaluate(() => {
          const srcdoc = document.createElement('iframe');
          srcdoc.id = 'srcdoc';
          srcdoc.srcdoc = '<p>SRCDOC_TEXT</p>';
          document.body.appendChild(srcdoc);
          const blank = document.createElement('iframe');
          blank.id = 'blank';
          document.body.appendChild(blank);
          const blob = document.createElement('iframe');
          blob.id = 'blob';
          blob.src = URL.createObjectURL(new Blob(['<p>BLOB_TEXT</p>'], { type: 'text/html' }));
          document.body.appendChild(blob);
          const data = document.createElement('iframe');
          data.id = 'data';
          data.src = 'data:text/html,<p>DATA_TEXT</p>';
          document.body.appendChild(data);
        });
        for (const selector of ['#srcdoc', '#blank', '#blob', '#data']) {
          const element = await framed.$(selector);
          assert.ok(element);
          const frame = await element.contentFrame();
          assert.ok(frame);
          await frame.waitForSelector('style#__enable_copy_style__', { state: 'attached', timeout: 1500 });
        }
        await setEnabled(false);
        for (const selector of ['#srcdoc', '#blank', '#blob', '#data']) {
          const element = await framed.$(selector);
          assert.ok(element);
          const frame = await element.contentFrame();
          assert.ok(frame);
          await frame.waitForSelector('style#__enable_copy_style__', { state: 'detached', timeout: 1500 });
        }
      } finally {
        await framed.close();
      }
    });

    await t.test('removed, moved and edited extension styles recover and disable cleanly', async () => {
      await setEnabled(true);
      try {
        await page.evaluate(() => {
          document.querySelector<HTMLElement>('#text')!.style.userSelect = 'none';
          const text = document.querySelector('style#__enable_copy_style__')!.firstChild;
          if (!(text instanceof Text)) throw new Error('Expected extension stylesheet text');
          text.data = '* { user-select: none !important; }';
        });
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#text')!).userSelect === 'auto');
        await page.evaluate(() => document.querySelector('style#__enable_copy_style__')!.remove());
        await page.waitForSelector('style#__enable_copy_style__', { state: 'attached' });
        await page.evaluate(() => {
          const host = document.createElement('div');
          host.id = 'style-shadow';
          document.body.appendChild(host);
          host.attachShadow({ mode: 'open' }).appendChild(document.querySelector('style#__enable_copy_style__')!);
        });
        await page.waitForSelector('style#__enable_copy_style__', { state: 'attached' });
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#text')!).userSelect), 'auto');
        await setEnabled(false);
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#text')!).userSelect), 'none');
      } finally {
        await page.evaluate(() => document.querySelector<HTMLElement>('#text')!.style.removeProperty('user-select'));
        await page.evaluate(() => document.querySelector('#style-shadow')?.remove());
      }
    });

    await t.test('site scope, existing tabs, cross-origin frames and reload', async () => {
      await setEnabled(true);
      const second = await browserContext.newPage();
      await second.goto('https://copy.test/second');
      const other = await browserContext.newPage();
      await other.goto('https://other.test/');
      await second.evaluate(() => {
        const iframe = document.createElement('iframe');
        iframe.src = 'https://embedded.test/';
        document.body.appendChild(iframe);
      });
      await second.frameLocator('iframe').locator('#text').waitFor();
      const embedded = second.frames().find(frame => frame.url().startsWith('https://embedded.test/'));
      assert.ok(embedded);
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
        return document.querySelector('.card p')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      }), true);
      await setEnabled(false);
      await page.keyboard.press('Control+c');
      assert.match(await page.locator('#log').textContent() ?? '', /快捷键/);
    });

    await t.test('popup toggles the current site and tracks storage changes', async () => {
      await popup.locator('.switch').click();
      await page.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      await popup.locator('.switch').click();
      await page.waitForSelector('#__enable_copy_style__', { state: 'detached' });
      await setEnabled(true);
      await popup.waitForFunction(() => document.querySelector<HTMLInputElement>('#toggle')!.checked);
      await popup.evaluate(key => chrome.storage.local.remove(key), key);
      await page.waitForSelector('#__enable_copy_style__', { state: 'detached' });
    });

    await t.test('popup initial reads cannot overwrite newer storage events', async () => {
      await setEnabled(true);
      await openPopup(page, 'initial-read');
      assert.equal(await popup.locator('#toggle').isChecked(), false);
      await page.waitForSelector('#__enable_copy_style__', { state: 'detached' });
    });

    await t.test('popup save completion cannot overwrite a superseding update', async () => {
      await setEnabled(false);
      await openPopup(page, 'save-superseded');
      await popup.locator('.switch').click();
      await popup.waitForFunction(() => document.querySelector('#main')!.getAttribute('aria-busy') === 'false');
      assert.equal(await popup.locator('#toggle').isChecked(), false);
      assert.equal(await popup.evaluate(key => chrome.storage.local.get(key).then(values => values[key]), key), false);
      await page.waitForSelector('#__enable_copy_style__', { state: 'detached' });
    });

    await t.test('failed popup saves preserve external updates and can be retried', async () => {
      await setEnabled(false);
      await openPopup(page, 'save-failed');
      await popup.locator('.switch').click();
      await popup.waitForFunction(() => document.querySelector('#main')!.getAttribute('aria-busy') === 'false');
      assert.equal(await popup.locator('#toggle').isChecked(), true);
      assert.equal(await popup.locator('#toggle').isEnabled(), true);
      assert.equal(await popup.locator('#tab-warning').isVisible(), true);
      await page.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      await popup.locator('.switch').click();
      await page.waitForSelector('#__enable_copy_style__', { state: 'detached' });
      assert.equal(await popup.locator('#tab-warning').isVisible(), false);
    });
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('existing root installs load the build and retain settings across browser restarts', { timeout: 30000 }, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'enable-copy-root-'));
  let context: BrowserContext | undefined;
  let firstId: string | undefined;
  try {
    for (const restart of [false, true]) {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
        headless: true,
        args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
      });
      await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const worlds: { id: number; origin: string }[] = [];
      cdp.on('Runtime.executionContextCreated', event => worlds.push(event.context));
      await cdp.send('Runtime.enable');
      await page.goto('https://copy.test/root-install');
      const world = worlds.find(item => item.origin.startsWith('chrome-extension://'));
      assert.ok(world, 'The root manifest must load the compiled content script');
      const extensionId = (await cdp.send('Runtime.evaluate', {
        expression: 'chrome.runtime.id', contextId: world.id, returnByValue: true,
      })).result.value;
      if (restart) {
        assert.equal(extensionId, firstId);
      } else {
        firstId = extensionId;
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${extensionId}/dist/popup.html`);
        await popup.waitForFunction(() => document.querySelector('#main')!.getAttribute('aria-busy') === 'false');
        await popup.evaluate(() => chrome.storage.local.set({ 'enable-copy:site:https://copy.test': true }));
      }
      await page.waitForSelector('style#__enable_copy_style__', { state: 'attached' });
      await context.close();
      context = undefined;
    }
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
