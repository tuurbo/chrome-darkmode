import { defineConfig } from 'wxt';
import { listSites, styleAssets } from './build/site-css.ts';

const sitesDirFor = (mode: string) => (mode === 'e2e' ? 'tests/fixtures/sites' : 'src/sites');

export default defineConfig({
  srcDir: 'src',
  manifest: ({ mode }) => ({
    name: 'Dusk',
    description: 'Private, per-site dark mode with no network access.',
    permissions: ['activeTab', 'declarativeContent', 'scripting', 'storage'],
    optional_host_permissions: ['*://*/*'],
    action: { default_title: 'Toggle dark mode for this site' },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; connect-src 'none'",
    },
    // The test browser cannot answer Chrome's permission prompt, so that build starts with access.
    ...(mode === 'e2e' ? { host_permissions: ['*://127.0.0.1/*', '*://*.localhost/*'] } : {}),
  }),
  vite: ({ mode }) => ({
    define: { __SITE_CSS__: JSON.stringify(listSites(sitesDirFor(mode))) },
  }),
  hooks: {
    'build:publicAssets': (wxt, files) => {
      files.push(...styleAssets(sitesDirFor(wxt.config.mode)));
    },
  },
});
