import { mount } from 'svelte';
import App from './App.svelte';
import { update, drafts } from './api.svelte.js';
import '@fontsource-variable/geist/wght.css';
import './app.css';

mount(App, { target: document.getElementById('app') });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const sw = navigator.serviceWorker;
  // An installed app is resumed rather than loaded again, and browsers look for a new sw.js only when a page loads.
  sw.register('/sw.js').then((reg) => {
    const check = () => reg.update().catch(() => {});
    setInterval(check, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      // Coming back to the app is when it can change under the user unnoticed.
      if (update.ready && !drafts.open) location.reload();
      else check();
    });
  });
  // sw.js takes over once it has cached the newest index.html (skipWaiting). The page loaded may already be that one.
  const mine = [...document.querySelectorAll('script[src], link[rel=stylesheet]')].map((e) => e.getAttribute('src') ?? e.getAttribute('href'));
  sw.addEventListener('controllerchange', async () => {
    const html = await (await caches.match('/'))?.text();
    if (html && mine.some((file) => !html.includes(file))) update.ready = true;
  });
  // A tapped notification names the view to show (sw.js, notificationclick).
  sw.addEventListener('message', (e) => {
    if (typeof e.data?.url === 'string') location.hash = new URL(e.data.url, location.origin).hash;
  });
}
