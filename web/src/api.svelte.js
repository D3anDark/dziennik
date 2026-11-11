/** `me` is undefined while booting, null when logged out. */
export const session = $state({ me: undefined });
import { untrack } from 'svelte';

const SYNCED_KEY = 'synced';
/**
 * `busy` counts `resource()` loads in flight: the header's refresh button turns while it is above zero.
 * `synced` is when the server last answered (ms), for the offline banner; 0 when unknown.
 */
export const net = $state({ online: navigator.onLine, busy: 0, synced: stored() });
function stored() {
  try {
    return Number(localStorage.getItem(SYNCED_KEY)) || 0;
  } catch {
    return 0;
  }
}
addEventListener('online', () => (net.online = true));
addEventListener('offline', () => (net.online = false));

/** The browser's offer to install the app, kept until the user is asked (Install.svelte). Chromium only. */
export const install = $state({ event: null });
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  install.event = e;
});
addEventListener('appinstalled', () => (install.event = null));
/** Only Safari on iOS and iPadOS has navigator.standalone; false there means a browser tab, where installing is done by
 *  hand from the share sheet. */
export const byHand = navigator.standalone === false;
/** Android in a browser tab. Not every browser there installs a web app well, so the app points to Chrome. */
export const android = /Android/i.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches;

/** `ready` once sw.js has taken over with a build newer than the one running (main.js). */
export const update = $state({ ready: false });

/**
 * Forms holding unsent text (Compose). Nothing reloads the app under them: iOS has no beforeunload to ask first.
 * Change it with `untrack`, from an effect.
 */
export const drafts = $state({ open: 0 });

/**
 * Bumping `tick` makes everything on screen load again: the refresh button does it, and so does coming back to
 * the app after a pause. An installed app has no reload button and can sit in the background for days.
 */
export const clock = $state({ tick: 0 });
const STALE_AFTER = 5 * 60 * 1000;
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > STALE_AFTER) clock.tick++;
});

const MESSAGES = {
  bad_credentials: 'Nieprawidłowy e-mail lub hasło.',
  captcha: 'Librus wymaga captcha. Zaloguj się raz na portal.librus.pl w przeglądarce, potem spróbuj ponownie.',
  not_allowed: 'Ten adres nie ma dostępu do aplikacji.',
  rate_limited: 'Za dużo prób logowania. Spróbuj za 15 minut.',
  maintenance: 'Librus ma przerwę techniczną.',
  login_flow: 'Librus pokazał nieoczekiwaną stronę (np. nowy regulamin). Zaloguj się na portal.librus.pl i ją zaakceptuj.',
  upstream: 'Librus nie odpowiada. Spróbuj później.',
  account_broken: 'To konto ucznia jest nieaktywne w Librusie.',
  offline: 'Brak połączenia i brak zapisanych danych.',
  http_403: 'Szkoła nie udostępnia tego modułu.',
  http_404: 'Brak danych w Librusie.',
  premium:
    'Librus udostępnia ten moduł poza swoją stroną tylko kontom z wykupionymi Mobilnymi Dodatkami, a to konto ich nie ma. Znajdziesz go na synergia.librus.pl.',
  bad_email: 'To nie wygląda na adres e-mail.',
  list_full: 'Lista dostępu jest pełna. Usuń nieużywane adresy.',
  forbidden: 'To może zrobić tylko administrator.',
  relogin: 'Sesja Librusa wygasła. Zaloguj się ponownie.',
  push_unsupported: 'Ta przeglądarka nie obsługuje powiadomień.',
  push_denied: 'Przeglądarka nie dała zgody na powiadomienia.',
  push_failed: 'Nie udało się wysłać powiadomienia na to urządzenie. Spróbuj ponownie.',
  bad_device: 'Serwer nie obsługuje usługi powiadomień tej przeglądarki.',
  unconfirmed: 'Librus nie potwierdził wysłania. Zanim wyślesz ponownie, sprawdź folder Wysłane.',
  one_group: 'Na tym koncie jedna wiadomość trafia do osób z jednej grupy. Zostaw odbiorców z jednej grupy.',
  subject_long: 'Temat może mieć najwyżej 150 znaków.',
  body_long: 'Treść może mieć najwyżej 20 000 znaków.',
};

export function message(e) {
  const text = MESSAGES[e?.message] ?? `Błąd: ${e?.message ?? e}`;
  // Librus says why it refused. Without its words every school-specific refusal reads the same.
  return e?.cause && /^http_/.test(e.message) ? `${text} Librus: „${e.cause}”` : text;
}

/** The demo build (vite --mode demo) has no server: demo.js answers in the page with made-up data. */
export const DEMO = import.meta.env.MODE === 'demo';

export async function api(path, init) {
  let res;
  try {
    res = DEMO ? (await import('./demo.js')).answer(path, init) : await fetch(`/api/${path}`, init);
  } catch {
    throw new Error('offline');
  }
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (res.status === 401 && (body?.error === 'unauthorized' || body?.error === 'relogin')) {
    // The session ended without a logout (it ran out, or access was taken away): the cached data goes as well.
    clearApiCache();
    session.me = null;
  }
  // Librus explains a refused write in MessagePL; views that write show it instead of the generic text.
  const cause = typeof body?.MessagePL === 'string' ? body.MessagePL : undefined;
  if (!res.ok) throw new Error(body?.error ?? `http_${res.status}`, { cause });
  net.synced = Date.now();
  try {
    localStorage.setItem(SYNCED_KEY, String(net.synced));
  } catch {
    // Storage blocked: the banner leaves the time out after a restart.
  }
  return body;
}

export const post = (path, data) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

/** What the Librus API serves only to accounts with Mobilne Dodatki, per its own app (navigator-pages.js). */
const PAID = /^(Messages|HomeWorkAssignments)\b/;

export const synergia = (login, path) =>
  api(`s/${encodeURIComponent(login)}/${path}`).catch(async (e) => {
    // A refusal of a paid module is named as such, but only once Librus confirms the account has no subscription.
    if (e.message === 'http_403' && PAID.test(path)) {
      const account = (await lookup(login, 'Me')).Me?.Account;
      if (account?.IsPremium === false && !account.IsPremiumDemo) throw new Error('premium');
    }
    throw e;
  });

/** POST to one of the writes the server allows (Messages, HomeWorkAssignments/MarkAsRead|MarkAsDone). */
export const write = (login, path, data) => post(`s/${encodeURIComponent(login)}/${path}`, data);

/** Unread message count behind the tab badge. Views that read or send messages call `refreshUnread`. */
/** `unread` is undefined until some source has answered. */
export const inbox = $state({ login: null, unread: undefined });

let unreadSeq = 0;

export function refreshUnread(login) {
  const seq = ++unreadSeq;
  return synergia(login, 'Messages/Unread').then(
    (r) => seq === unreadSeq && inbox.login === login && (inbox.unread = Number(r.UnreadMessages) || 0),
    (e) => e.message, // badge only: the last count stays, and the reason goes to a caller that knows another source
  );
}

const lookups = new Map();
const LOOKUP_MAX = 40;

/**
 * Dictionaries (Users, Subjects, categories, types) shared by every view for the page lifetime.
 * They only label data, so a failure resolves to {} and is not cached: the view still renders, names retry next load.
 */
export function lookup(login, path) {
  const key = `${login}/${path}`;
  let p = lookups.get(key);
  if (!p) {
    p = synergia(login, path).catch(() => {
      if (lookups.get(key) === p) lookups.delete(key);
      return {};
    });
    lookups.set(key, p);
    if (lookups.size > LOOKUP_MAX) lookups.delete(lookups.keys().next().value);
  }
  return p;
}

/**
 * The last answer of every keyed `resource()`, newest last, so a view shows at once what it showed before while a
 * fresh answer loads. Kept in IndexedDB between starts (written when the app goes to the background) and only for
 * the build that made it: another build may shape its data differently.
 */
const REMEMBER_MAX = 40;
const remembered = new Map();
const BUILD = import.meta.url;
const DB = 'dziennik';
const STORE = 'views';

function remember(key, data) {
  remembered.delete(key);
  remembered.set(key, data);
  if (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value);
}

/** Runs `op(store)` in one transaction; resolves with the request's result. Fails where IndexedDB is off. */
function idb(mode, op) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(req.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

const restored = idb('readonly', (s) => s.get('last'))
  .then((saved) => {
    if (saved?.build !== BUILD) return;
    for (const [key, data] of saved.entries) if (!remembered.has(key)) remembered.set(key, data);
  })
  .catch(() => {});

document.addEventListener('visibilitychange', () => {
  // Data that cannot be cloned (it never should be) is just not kept.
  if (document.hidden) idb('readwrite', (s) => s.put({ build: BUILD, entries: [...remembered] }, 'last')).catch(() => {});
});

/** Errors a second try can mend: no connection, Librus down or busy. */
const passing = (e) => ['offline', 'upstream', 'maintenance'].includes(e?.message) || /^http_5\d\d$/.test(e?.message);

/**
 * Loads `fn()` in an effect: reactive values read before its first await (props like `login`) re-run it,
 * as does `clock`, and a superseded run never overwrites a newer one. Call during component init.
 * A pre-effect clears `data` before the template re-renders, so markup never sees the previous run's shape.
 * `key()` names the answer by everything `fn` depends on; with it the last answer shows until the new one is in.
 * `error` is set when nothing can be shown, `failed` when a refresh failed under data still on screen; `retry` says
 * whether trying again can help.
 */
export function resource(fn, key) {
  const r = $state({ data: undefined, error: '', failed: '', retry: false });
  let seen = clock.tick;
  $effect.pre(() => {
    let stale = false;
    const k = key?.();
    // A refresh keeps what is on screen until the new answer is in, and keeps it if the refresh fails.
    const refresh = clock.tick !== seen && untrack(() => r.data) !== undefined;
    seen = clock.tick;
    const known = k ? remembered.get(k) : undefined;
    if (!refresh) r.data = known;
    // At start the saved answers may still be on their way from IndexedDB.
    if (k && !refresh && known === undefined) restored.then(() => !stale && r.data === undefined && !r.error && (r.data = remembered.get(k)));
    r.error = r.failed = '';
    r.retry = false;
    untrack(() => net.busy++);
    fn()
      .then(
        (d) => {
          if (stale) return;
          r.data = d;
          if (k) remember(k, d);
        },
        (e) => {
          if (stale) return;
          r.retry = passing(e);
          if (untrack(() => r.data) === undefined) r.error = message(e);
          // Offline the banner already says the data is from the last connection.
          else if (e.message !== 'offline') r.failed = message(e);
        },
      )
      .finally(() => net.busy--);
    return () => (stale = true);
  });
  return r;
}

/** Student data cached by sw.js must not outlive the session on a shared device. */
export function clearApiCache() {
  lookups.clear();
  remembered.clear();
  net.synced = 0;
  try {
    localStorage.removeItem(SYNCED_KEY);
    // Which new grades were opened (data.js): nothing of a student stays behind on a shared device.
    for (const k of Object.keys(localStorage)) if (k.startsWith('seen-grades/')) localStorage.removeItem(k);
  } catch {
    // Storage blocked: nothing was saved.
  }
  return Promise.all([
    'caches' in window && caches.delete('api-v1'),
    idb('readwrite', (s) => s.delete('last')).catch(() => {}),
  ]);
}

/** Librus mixes numeric and string ids for the same entity; key everything by string. */
export const byId = (list) => new Map((list ?? []).map((x) => [String(x.Id), x]));
