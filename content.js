'use strict';

(() => {
  const STYLE_ID = '__enable_copy_style__';
  const BLOCKED_EVENTS = ['contextmenu', 'copy', 'cut', 'selectstart'];
  const SHORTCUT_KEYS = new Set(['a', 'c', 'x']);
  const ancestors = location.ancestorOrigins;
  const site = ancestors.length ? ancestors[ancestors.length - 1] : location.origin;
  const storageKey = `enable-copy:site:${site}`;
  const INTERACTIVE = 'input, textarea, select, button, a[href], [role="textbox"], [role="grid"], [role="combobox"]';

  let active = false;
  let styleObserver = null;
  let stateRevision = 0;
  let interactiveClick = null;

  function isInteractive(node) {
    return node instanceof Element && (node.isContentEditable || node.closest(INTERACTIVE));
  }

  function preservePageEvent(e) {
    return e.composedPath().some(isInteractive) || isInteractive(document.activeElement);
  }

  function hasTextSelection() {
    return Boolean(window.getSelection()?.toString());
  }

  function stopEvent(e) {
    if (!active || preservePageEvent(e)) return;
    if (e.type === 'copy' || e.type === 'cut') {
      // execCommand emits a separate event whose path may omit the button.
      if (interactiveClick && interactiveClick.eventPhase !== Event.NONE) return;
      if (!hasTextSelection()) return;
    }
    e.stopImmediatePropagation();
  }

  // Without a native text selection, copying may depend entirely on page code.
  function unblockKeys(e) {
    if (!active || preservePageEvent(e) || !hasTextSelection() || e.altKey || e.shiftKey) return;
    if ((e.ctrlKey || e.metaKey) && SHORTCUT_KEYS.has(e.key.toLowerCase())) {
      e.stopImmediatePropagation();
    }
  }

  // Keep the click through all page listeners; a microtask can run between them.
  // eventPhase limits the exemption to dispatch, even before the timer runs.
  window.addEventListener('click', e => {
    if (!active || !e.composedPath().some(isInteractive)) return;
    interactiveClick = e;
    setTimeout(() => {
      if (interactiveClick === e) interactiveClick = null;
    }, 0);
  }, true);

  // Register before page scripts, including while disabled, to retain priority
  // over page listeners at window capture when the site is enabled later.
  for (const type of BLOCKED_EVENTS) window.addEventListener(type, stopEvent, true);
  window.addEventListener('keydown', unblockKeys, true);

  function injectStyle() {
    if (!active || !document.documentElement) return;
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
    styleObserver.observe(document, { childList: true, subtree: true });
  }

  function enable() {
    if (active) return;
    active = true;
    injectStyle();
    watchStyle();
  }

  function disable() {
    if (!active) return;
    active = false;
    interactiveClick = null;
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    if (styleObserver) {
      styleObserver.disconnect();
      styleObserver = null;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, storageKey)) return;
    stateRevision++;
    if (changes[storageKey].newValue === true) enable();
    else disable();
  });

  const initialRevision = stateRevision;
  chrome.storage.local.get(storageKey, (values) => {
    if (stateRevision !== initialRevision) return;
    if (values[storageKey] === true) enable();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'enable-copy:ping') {
      sendResponse({ active, site, storageKey });
    }
  });
})();
