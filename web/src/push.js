import { api, post } from './api.svelte.js';

/** Web Push needs these three; on iOS they exist only in an app added to the home screen. */
export const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** This browser's subscription, or null. */
export async function current() {
  if (!supported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission, so it has to run inside a tap, then registers this browser with the server. */
export async function enable(key) {
  const reg = supported && (await navigator.serviceWorker.getRegistration());
  if (!reg) throw new Error('push_unsupported');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('push_denied');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  await post('push', sub.toJSON());
}

export async function disable() {
  const sub = await current();
  if (!sub) return;
  await api('push', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
  await sub.unsubscribe();
}

/**
 * Run after sign-in. The server forgets devices with a user's last session and the browser does not, so an
 * existing subscription is sent again; one made for another server key is replaced.
 */
export async function sync(key) {
  const sub = await current();
  if (!sub || Notification.permission !== 'granted') return;
  if (sub.options.applicationServerKey && b64(sub.options.applicationServerKey) !== key) {
    await sub.unsubscribe();
    return enable(key);
  }
  await post('push', sub.toJSON());
}
