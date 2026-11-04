export const OFF_ATTRIBUTE = 'data-dusk-off';

export interface UrlCondition {
  hostEquals?: string;
  hostSuffix?: string;
}

const isIpAddress = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');

export function siteFromUrl(url: string | undefined): string | null {
  if (!url || !URL.canParse(url)) return null;
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return hostname.replace(/^www\.(?=[^.]+\.)/, '');
}

export function matchPattern(site: string): string {
  return isIpAddress(site) ? `*://${site}/*` : `*://*.${site}/*`;
}

export const covers = (site: string, host: string) => host === site || host.endsWith(`.${site}`);

/** The site files that apply on a host, which are its own and its parent sites', parents first. */
export const siteFilesFor = (host: string, files: string[]) =>
  files.filter((file) => covers(file, host)).sort((a, b) => a.length - b.length);

export function urlConditions(site: string): UrlCondition[] {
  if (isIpAddress(site)) return [{ hostEquals: site }];
  return [{ hostEquals: site }, { hostSuffix: `.${site}` }];
}
