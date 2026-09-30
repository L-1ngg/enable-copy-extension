import { PING_TYPE, siteStorageKey } from './protocol';
import type { SiteState } from './protocol';

const STYLE_ID = '__enable_copy_style__';
const STYLE_TEXT = '*, *::before, *::after { -webkit-user-select: auto !important; -moz-user-select: auto !important; user-select: auto !important; }';
const BLOCKED_EVENTS = ['contextmenu', 'copy', 'cut', 'selectstart'];
const SHORTCUT_KEYS = new Set(['a', 'c', 'x']);
const ancestors = location.ancestorOrigins;
const site = ancestors[ancestors.length - 1] ?? location.origin;
const storageKey = siteStorageKey(site);
const INTERACTIVE = 'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="textbox"], [role="grid"], [role="combobox"]';

let active = false;
let style: HTMLStyleElement | null = null;
let styleObserver: MutationObserver | null = null;
let stateRevision = 0;
const interactiveClicks = new Set<Event>();

function isInteractive(node: EventTarget | null): boolean {
  return node instanceof Element
    && ((node instanceof HTMLElement && node.isContentEditable) || node.closest(INTERACTIVE) !== null);
}

function preservePageEvent(event: Event): boolean {
  if (event.composedPath().some(isInteractive)) return true;
  let focused = document.activeElement;
  while (focused) {
    if (isInteractive(focused)) return true;
    focused = focused.shadowRoot?.activeElement ?? null;
  }
  return false;
}

function hasTextSelection(): boolean {
  return Boolean(window.getSelection()?.toString());
}

function hasInteractiveClick(): boolean {
  for (const event of interactiveClicks) {
    if (event.eventPhase !== Event.NONE) return true;
    interactiveClicks.delete(event);
  }
  return false;
}

function stopEvent(event: Event): void {
  if (!active || preservePageEvent(event)) return;
  if (event.type === 'copy' || event.type === 'cut') {
    // execCommand can omit the button from the copy event's path.
    if (hasInteractiveClick() || !hasTextSelection()) return;
  }
  event.stopImmediatePropagation();
}

function unblockKeys(event: KeyboardEvent): void {
  if (!active || preservePageEvent(event) || event.altKey || event.shiftKey || event.isComposing) return;
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  const hasSelection = hasTextSelection();
  // An unlabelled focused widget may implement its own select-all command.
  if (key === 'a' && !hasSelection && document.activeElement !== document.body
    && document.activeElement !== document.documentElement && document.activeElement !== null) return;
  if (SHORTCUT_KEYS.has(key) && (key === 'a' || hasSelection)) {
    event.stopImmediatePropagation();
  }
}

window.addEventListener('click', event => {
  if (!active || !event.composedPath().some(isInteractive)) return;
  // Track nested button clicks separately until their dispatch has finished.
  interactiveClicks.add(event);
  setTimeout(() => interactiveClicks.delete(event), 0);
}, true);

// Register at document_start, even while disabled, to retain capture priority.
for (const type of BLOCKED_EVENTS) window.addEventListener(type, stopEvent, true);
window.addEventListener('keydown', unblockKeys, true);

function injectStyle(): void {
  if (!active) return;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
  }
  if (style.textContent !== STYLE_TEXT) style.textContent = STYLE_TEXT;
  const parent = document.head ?? document.documentElement;
  if (parent && style.getRootNode() !== document) parent.appendChild(style);
}

function enable(): void {
  if (active) return;
  active = true;
  injectStyle();
  styleObserver = new MutationObserver(injectStyle);
  styleObserver.observe(document, { childList: true, subtree: true });
  if (style) {
    styleObserver.observe(style, { childList: true, subtree: true, characterData: true });
  }
}

function disable(): void {
  active = false;
  interactiveClicks.clear();
  styleObserver?.disconnect();
  styleObserver = null;
  // Remove only the owned node, even if the page uses the same ID.
  style?.remove();
  style = null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.hasOwn(changes, storageKey)) return;
  stateRevision++;
  if (changes[storageKey]?.newValue === true) enable();
  else disable();
});

const initialRevision = stateRevision;
chrome.storage.local.get(storageKey, values => {
  if (chrome.runtime.lastError || stateRevision !== initialRevision) return;
  if (values[storageKey] === true) enable();
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== PING_TYPE) return;
  const state: SiteState = { active, site, storageKey };
  sendResponse(state);
});
