'use strict';

const toggle = document.getElementById('toggle');
const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const statusSub = document.getElementById('status-sub');
const tabWarning = document.getElementById('tab-warning');
let storageKey = null;

function render(enabled) {
  toggle.checked = enabled;
  dot.classList.toggle('on', enabled);
  statusText.textContent = enabled ? '本站已启用' : '本站已停用';
}

toggle.addEventListener('change', async () => {
  if (!storageKey) return;
  const enabled = toggle.checked;
  toggle.disabled = true;
  tabWarning.hidden = true;
  try {
    await chrome.storage.local.set({ [storageKey]: enabled });
    render(enabled);
  } catch (_) {
    render(!enabled);
    tabWarning.textContent = '设置保存失败，请重试';
    tabWarning.hidden = false;
  } finally {
    toggle.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && storageKey && Object.hasOwn(changes, storageKey)) {
    render(changes[storageKey].newValue === true);
  }
});

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('No active tab');
    const state = await chrome.tabs.sendMessage(tab.id, { type: 'enable-copy:ping' }, { frameId: 0 });
    if (!state?.storageKey) throw new Error('Content script unavailable');
    storageKey = state.storageKey;
    statusSub.textContent = state.site;
    const values = await chrome.storage.local.get(storageKey);
    render(values[storageKey] === true);
    toggle.disabled = false;
  } catch (_) {
    statusText.textContent = '当前页面不可用';
    statusSub.textContent = '';
    tabWarning.hidden = false;
  }
})();
