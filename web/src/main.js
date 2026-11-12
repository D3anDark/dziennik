import { mount } from 'svelte';
import App from './App.svelte';
import { update, drafts, DEMO } from './api.svelte.js';
import '@fontsource-variable/geist/wght.css';
import './app.css';
import { applyTheme } from './util.js';

// The demo seen on another day of the school year (?dzien=2027-03-16, picked in its banner): the clock moves there,
// keeping the time of day, so its data and every view agree on what today is.
const day = DEMO && new URLSearchParams(location.search).get('dzien');
if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
  const RealDate = Date;
  const now = new RealDate();
  const target = new RealDate(`${day}T00:00`);
  target.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  const offset = target - now;
  // A string that is no date (2027-13-01) leaves the clock alone.
  if (!isNaN(offset))
    globalThis.Date = class extends RealDate {
      constructor(...a) {
        if (a.length) super(...a);
        else super(RealDate.now() + offset);
      }
      static now() {
        return RealDate.now() + offset;
      }
    };
}

applyTheme();
mount(App, { target: document.getElementById('app') });

// The demo is a page on a static host, without a server to install from or push through.
if ('serviceWorker' in navigator && import.meta.env.PROD && !DEMO) {
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
