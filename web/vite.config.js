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

/**
 * The link preview of the demo, which alone is a public page: the app itself sits behind a sign-in on servers of its
 * own. Discord builds the card from components (docs.discord.com/developers/link-previews/component-embeds): one
 * Container of at most 3000 bytes, in the page as the server sends it, with absolute addresses. The Open Graph tags
 * are the card everywhere else, and Discord's own when it refuses the components. The pictures are screenshots of the
 * demo (`SHOTS=dir e2e/demo.sh`), kept in demo/.
 */
const DEMO = 'https://d3andark.github.io/dziennik/';
const REPO = 'https://github.com/D3anDark/dziennik';
const ABOUT = 'Nieoficjalna aplikacja do dziennika LIBRUS: oceny ze średnimi, plan lekcji, frekwencja, wiadomości, terminarz i powiadomienia.';
const SAMPLE = 'Wersja demo: przykładowe dane, bez logowania i bez serwera.';
const PICTURES = [
  ['embed-start.png', 'Ekran startowy: plan na jutro z zastępstwem i przerwami, najbliższe sprawdziany i zebrania'],
  ['embed-oceny.png', 'Oceny: przedmiot w wierszu, kolorowe oceny i średnia semestru przy prawej krawędzi'],
];
const EMBED_MAX = 3000;

const demoEmbed = {
  name: 'demo-embed',
  transformIndexHtml() {
    const link = (url, label) => ({ type: 2, style: 5, url, label });
    const card = JSON.stringify({
      component: {
        type: 17,
        accent_color: 0x1f5fa8,
        components: [
          { type: 9, components: [{ type: 10, content: `# [Dziennik](${DEMO})\n${ABOUT}` }], accessory: { type: 11, media: { url: `${DEMO}icon-512.png` } } },
          { type: 12, items: PICTURES.map(([file, description]) => ({ media: { url: DEMO + file }, description })) },
          { type: 10, content: `*${SAMPLE}*` },
          { type: 1, components: [link(DEMO, 'Otwórz demo'), link(REPO, 'Kod i instalacja')] },
        ],
      },
    });
    // Over the limit Discord shows no card at all, and a "<" could end the script element early.
    if (Buffer.byteLength(card) > EMBED_MAX || card.includes('<')) throw new Error(`demo embed: ${Buffer.byteLength(card)} bytes of ${EMBED_MAX}, or a "<" in it`);
    const meta = (key, name, content) => ({ tag: 'meta', attrs: { [key]: name, content }, injectTo: 'head' });
    return [
      meta('property', 'og:site_name', 'Dziennik'),
      meta('property', 'og:title', 'Dziennik: wersja demo'),
      meta('property', 'og:description', `${ABOUT} ${SAMPLE}`),
      meta('property', 'og:url', DEMO),
      meta('property', 'og:type', 'website'),
      meta('property', 'og:locale', 'pl_PL'),
      meta('property', 'og:image', DEMO + PICTURES[0][0]),
      meta('property', 'og:image:width', '1280'),
      meta('property', 'og:image:height', '800'),
      meta('property', 'og:image:alt', PICTURES[0][1]),
      meta('name', 'twitter:card', 'summary_large_image'),
      { tag: 'script', attrs: { id: 'discord:component-embed', type: 'application/json' }, children: card, injectTo: 'head' },
    ];
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [svelte(), stampServiceWorker, ...(mode === 'demo' ? [demoEmbed] : [])],
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
}));
