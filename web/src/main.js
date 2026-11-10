import { mount } from 'svelte';
import App from './App.svelte';
import '@fontsource-variable/geist/wght.css';
import './app.css';

mount(App, { target: document.getElementById('app') });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js');
  // A tapped notification names the view to show (sw.js, notificationclick).
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (typeof e.data?.url === 'string') location.hash = new URL(e.data.url, location.origin).hash;
  });
}
