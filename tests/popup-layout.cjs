const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'dist');

// Action popups start as "other" targets, so Playwright does not expose them
// as pages. Attach directly without emulating a viewport or resizing the popup.
async function attachPopup(browserSession, targetId) {
  const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId, flatten: false });
  let sequence = 0;
  const pending = new Map();
  const onMessage = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  browserSession.on('Target.receivedMessageFromTarget', onMessage);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    browserSession.send('Target.sendMessageToTarget', {
      sessionId, message: JSON.stringify({ id, method, params }),
    }).catch(error => { pending.delete(id); reject(error); });
  });
  return {
    send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    async close() {
      browserSession.off('Target.receivedMessageFromTarget', onMessage);
      await browserSession.send('Target.closeTarget', { targetId });
    },
  };
}

for (const scale of [1, 1.25, 1.5]) {
  test(`native toolbar popup layout at display scale ${scale}`, { timeout: 30000 }, async () => {
    const profile = await mkdtemp(path.join(tmpdir(), 'enable-copy-popup-'));
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        executablePath: process.env.CHROMIUM_PATH || undefined,
        headless: false,
        viewport: null,
        colorScheme: 'light',
        args: [
          `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`,
          `--force-device-scale-factor=${scale}`,
        ],
      });
      await context.route('https://**/*', route => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><html><body>Copy text</body></html>',
      }));
      const page = await context.newPage();
      const pageSession = await context.newCDPSession(page);
      const worlds = [];
      pageSession.on('Runtime.executionContextCreated', event => worlds.push(event.context));
      await pageSession.send('Runtime.enable');
      await page.goto('https://github.com/');
      const world = worlds.find(item => item.origin.startsWith('chrome-extension://'));
      assert.ok(world);
      const extensionId = (await pageSession.send('Runtime.evaluate', {
        expression: 'chrome.runtime.id', contextId: world.id, returnByValue: true,
      })).result.value;
      const popupUrl = `chrome-extension://${extensionId}/popup.html`;
      const control = await context.newPage();
      await control.goto(popupUrl);
      const browserSession = await context.browser().newBrowserCDPSession();

      const openPopup = async () => {
        await page.bringToFront();
        const existing = new Set((await browserSession.send('Target.getTargets')).targetInfos.map(t => t.targetId));
        await control.evaluate(() => chrome.action.openPopup());
        const target = (await browserSession.send('Target.getTargets')).targetInfos.find(t => !existing.has(t.targetId));
        assert.ok(target, 'Chrome must create a real action popup');
        const popup = await attachPopup(browserSession, target.targetId);
        await popup.evaluate(`new Promise(resolve => {
          const ready = () => {
            if (document.querySelector('#main')?.getAttribute('aria-busy') !== 'false') {
              setTimeout(ready, 20);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
          };
          ready();
        })`);
        return popup;
      };
      const checkLayout = async (popup, name) => {
        const metrics = await popup.evaluate(`(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
          const singleLine = selector => {
            const node = document.querySelector(selector);
            return node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1;
          };
          return {
            width: innerWidth, height: innerHeight,
            bodyWidth: document.body.getBoundingClientRect().width,
            scrollWidth: document.documentElement.scrollWidth,
            titleSingleLine: singleLine('.title'), statusSingleLine: singleLine('#status-text'),
            status: rect('#status-text'), toggle: rect('.switch'), site: rect('#status-sub'),
          };
        })()`);
        assert.equal(metrics.bodyWidth, 320, JSON.stringify(metrics));
        assert.ok(Math.abs(metrics.width - 320) <= 1, JSON.stringify(metrics));
        assert.ok(metrics.scrollWidth <= metrics.width, JSON.stringify(metrics));
        assert.ok(metrics.titleSingleLine && metrics.statusSingleLine, JSON.stringify(metrics));
        assert.ok(metrics.status.right <= metrics.toggle.left, JSON.stringify(metrics));
        assert.ok(metrics.site.right <= metrics.width, JSON.stringify(metrics));
        if (process.env.POPUP_SCREENSHOT_DIR) {
          await mkdir(process.env.POPUP_SCREENSHOT_DIR, { recursive: true });
          const screenshot = await popup.send('Page.captureScreenshot');
          await writeFile(path.join(process.env.POPUP_SCREENSHOT_DIR, `${name}-${scale}.png`), Buffer.from(screenshot.data, 'base64'));
        }
      };

      let popup = await openPopup();
      await checkLayout(popup, 'disabled');
      assert.equal(await popup.evaluate("document.querySelector('#status-sub').textContent"), 'github.com');
      assert.equal(await popup.evaluate("document.querySelector('#status-sub').title"), 'https://github.com');
      await popup.evaluate("document.querySelector('#toggle').click()");
      await page.waitForSelector('#__enable_copy_style__', { state: 'attached' });
      await checkLayout(popup, 'enabled');
      await popup.evaluate(`(() => {
        chrome.storage.local.set = async () => { throw new Error('Simulated storage failure'); };
        document.querySelector('#toggle').click();
      })()`);
      await popup.evaluate(`new Promise(resolve => {
        const ready = () => {
          if (document.querySelector('#main').getAttribute('aria-busy') !== 'false') return setTimeout(ready, 20);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        };
        ready();
      })`);
      await checkLayout(popup, 'save-failed');
      assert.equal(await popup.evaluate("document.querySelector('#toggle').checked"), true);
      assert.equal(await popup.evaluate("document.querySelector('#toggle').disabled"), false);
      assert.equal(await popup.evaluate("document.querySelector('#tab-warning').hidden"), false);
      await popup.close();

      await page.goto('https://a-very-long-subdomain-for-checking-popup-layout.documentation.example.com:8443/');
      popup = await openPopup();
      await checkLayout(popup, 'long-site');
      await popup.close();

      await page.goto('chrome://version');
      popup = await openPopup();
      await checkLayout(popup, 'unavailable');
      assert.equal(await popup.evaluate("document.querySelector('#toggle').disabled"), true);
      await popup.close();
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
