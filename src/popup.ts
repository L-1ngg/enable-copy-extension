import { PING_TYPE, isSiteState } from './protocol';

const toggle = document.querySelector<HTMLInputElement>('#toggle')!;
const dot = document.querySelector<HTMLElement>('#dot')!;
const statusText = document.querySelector<HTMLElement>('#status-text')!;
const statusSub = document.querySelector<HTMLElement>('#status-sub')!;
const tabWarning = document.querySelector<HTMLElement>('#tab-warning')!;
const main = document.querySelector<HTMLElement>('#main')!;

let storageKey: string | null = null;
let confirmedEnabled = false;
let stateRevision = 0;
let saving = false;

function render(): void {
  toggle.checked = confirmedEnabled;
  dot.classList.toggle('on', confirmedEnabled);
  document.body.dataset.state = confirmedEnabled ? 'enabled' : 'disabled';
  statusText.textContent = saving ? '正在保存' : confirmedEnabled ? '本站已启用' : '本站已停用';
}

toggle.addEventListener('change', async () => {
  if (!storageKey || saving) {
    render();
    return;
  }
  const enabled = toggle.checked;
  const revision = stateRevision;
  saving = true;
  toggle.disabled = true;
  main.setAttribute('aria-busy', 'true');
  statusText.textContent = '正在保存';
  tabWarning.hidden = true;
  try {
    await chrome.storage.local.set({ [storageKey]: enabled });
    // A later storage event takes precedence over this write's completion.
    if (stateRevision === revision) confirmedEnabled = enabled;
  } catch {
    tabWarning.textContent = '设置保存失败，请重试';
    tabWarning.hidden = false;
  } finally {
    saving = false;
    render();
    toggle.disabled = false;
    main.setAttribute('aria-busy', 'false');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !storageKey || !Object.hasOwn(changes, storageKey)) return;
  stateRevision++;
  confirmedEnabled = changes[storageKey]?.newValue === true;
  render();
});

async function initialize(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('No active tab');
    const state: unknown = await chrome.tabs.sendMessage(tab.id, { type: PING_TYPE }, { frameId: 0 });
    if (!isSiteState(state)) throw new Error('Content script unavailable');
    const siteUrl = new URL(state.site);
    storageKey = state.storageKey;
    statusSub.textContent = siteUrl.host || state.site;
    statusSub.title = state.site;
    const revision = stateRevision;
    const values = await chrome.storage.local.get(storageKey);
    if (stateRevision === revision) confirmedEnabled = values[storageKey] === true;
    render();
    toggle.disabled = false;
  } catch {
    storageKey = null;
    confirmedEnabled = false;
    render();
    toggle.disabled = true;
    document.body.dataset.state = 'unavailable';
    statusText.textContent = '当前页面不可用';
    statusSub.textContent = '无法获取站点';
    tabWarning.hidden = false;
  } finally {
    main.setAttribute('aria-busy', 'false');
  }
}

void initialize();
