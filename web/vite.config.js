import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/**
 * Browsers install a new service worker only when sw.js differs byte for byte, and ours reads the files to cache
 * from index.html, so every build stamps it with the names of what it built (main.js then offers the reload).
 */
const stampServiceWorker = {
  name: 'stamp-sw',
  apply: 'build',
  writeBundle(output, bundle) {
    const id = createHash('sha256').update(Object.keys(bundle).sort().join('\n')).digest('hex').slice(0, 12);
    appendFileSync(join(output.dir, 'sw.js'), `// build ${id}\n`);
  },
};

export default defineConfig({
  plugins: [svelte(), stampServiceWorker],
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
