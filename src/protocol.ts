export const PING_TYPE = 'enable-copy:ping';

export interface SiteState {
  active: boolean;
  site: string;
  storageKey: string;
}

export function siteStorageKey(site: string): string {
  return `enable-copy:site:${site}`;
}

export function isSiteState(value: unknown): value is SiteState {
  return typeof value === 'object' && value !== null
    && 'active' in value && typeof value.active === 'boolean'
    && 'site' in value && typeof value.site === 'string'
    && 'storageKey' in value && value.storageKey === siteStorageKey(value.site);
}
