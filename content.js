'use strict';

(() => {
  const STYLE_ID = '__enable_copy_style__';
  const BLOCKED_EVENTS = ['contextmenu', 'copy', 'cut', 'selectstart', 'select'];
  const SHORTCUT_KEYS = new Set(['a', 'c', 'p', 's', 'u', 'x']);
  const INLINE_PROPS = ['oncontextmenu', 'oncopy', 'oncut', 'onselectstart', 'onselect'];

  let active = false;
  let styleObserver = null;

  // Runs at document_start, so these capture listeners register before page
  // scripts. stopImmediatePropagation() at window capture prevents the event
  // from ever reaching page handlers further down the tree.
  function stopEvent(e) {
    e.stopImmediatePropagation();
  }

  // Only intercept copy-related shortcuts; leave other keydown handlers alone
  // so editors and site shortcuts keep working.
  function unblockKeys(e) {
    if (e.key === 'F12' || ((e.ctrlKey || e.metaKey) && SHORTCUT_KEYS.has(e.key.toLowerCase()))) {
      e.stopImmediatePropagation();
    }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '*, *::before, *::after { -webkit-user-select: auto !important; -moz-user-select: auto !important; user-select: auto !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  // Some sites strip foreign style nodes; re-add ours if it disappears.
  function watchStyle() {
    if (styleObserver) return;
    styleObserver = new MutationObserver(() => {
      if (!document.getElementById(STYLE_ID)) injectStyle();
    });
    styleObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function clearInlineHandlers() {
    for (const el of [document, document.body, document.documentElement]) {
      if (!el) continue;
      for (const prop of INLINE_PROPS) {
        try {
          el[prop] = null;
        } catch (_) {
          // read-only on some pages; the capture listeners still cover it
        }
      }
    }
  }

  function enable() {
    if (active) return;
    active = true;
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, stopEvent, true);
    window.addEventListener('keydown', unblockKeys, true);
    injectStyle();
    watchStyle();
    clearInlineHandlers();
  }

  function disable() {
    if (!active) return;
    active = false;
    for (const type of BLOCKED_EVENTS) window.removeEventListener(type, stopEvent, true);
    window.removeEventListener('keydown', unblockKeys, true);
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    if (styleObserver) {
      styleObserver.disconnect();
      styleObserver = null;
    }
  }

  chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
    if (enabled) enable();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'enable-copy:set') {
      if (msg.enabled) enable();
      else disable();
    } else if (msg && msg.type === 'enable-copy:ping') {
      sendResponse({ active });
    }
  });
})();
