'use strict';

const toggle = document.getElementById('toggle');

chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  toggle.checked = enabled;
});

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
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
