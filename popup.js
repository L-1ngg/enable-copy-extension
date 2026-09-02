'use strict';

const toggle = document.getElementById('toggle');
const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const statusSub = document.getElementById('status-sub');
const tabWarning = document.getElementById('tab-warning');

function render(enabled) {
  toggle.checked = enabled;
  dot.classList.toggle('on', enabled);
  statusText.textContent = enabled ? '已启用' : '已停用';
  statusSub.textContent = enabled
    ? '正在解除当前页面的复制限制'
    : '所有页面保持网站默认行为';
}

chrome.storage.local.get({ enabled: true }, ({ enabled }) => render(enabled));

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  render(enabled);
  await chrome.storage.local.set({ enabled });

  // Notify the active tab so the toggle takes effect without a reload.
  // Fails silently on pages where content scripts can't run (chrome://, Web Store).
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id !== undefined) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'enable-copy:set', enabled });
    } catch (_) {
      // no content script on this page
    }
  }
});

// Detect pages the extension cannot inject into and show a hint.
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'enable-copy:ping' });
  } catch (_) {
    tabWarning.hidden = false;
  }
})();
