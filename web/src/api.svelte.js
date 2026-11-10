/** `me` is undefined while booting, null when logged out. */
export const session = $state({ me: undefined });
import { untrack } from 'svelte';

/** `busy` counts `resource()` loads in flight: the header's refresh button turns while it is above zero. */
export const net = $state({ online: navigator.onLine, busy: 0 });
addEventListener('online', () => (net.online = true));
addEventListener('offline', () => (net.online = false));

/** The browser's offer to install the app, kept until the user is asked (Install.svelte). Chromium only. */
export const install = $state({ event: null });
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  install.event = e;
});
addEventListener('appinstalled', () => (install.event = null));

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
};

export function message(e) {
  const text = MESSAGES[e?.message] ?? `Błąd: ${e?.message ?? e}`;
  // Librus says why it refused. Without its words every school-specific refusal reads the same.
  return e?.cause && /^http_/.test(e.message) ? `${text} Librus: „${e.cause}”` : text;
}

export async function api(path, init) {
  let res;
  try {
    res = await fetch(`/api/${path}`, init);
  } catch {
    throw new Error('offline');
  }
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (res.status === 401 && (body?.error === 'unauthorized' || body?.error === 'relogin')) {
    session.me = null;
  }
  // Librus explains a refused write in MessagePL; views that write show it instead of the generic text.
  const cause = typeof body?.MessagePL === 'string' ? body.MessagePL : undefined;
  if (!res.ok) throw new Error(body?.error ?? `http_${res.status}`, { cause });
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
 * Loads `fn()` in an effect: reactive values read before its first await (props like `login`) re-run it,
 * as does `clock`, and a superseded run never overwrites a newer one. Call during component init.
 * A pre-effect clears `data` before the template re-renders, so markup never sees the previous run's shape.
 */
export function resource(fn) {
  const r = $state({ data: undefined, error: '' });
  let seen = clock.tick;
  $effect.pre(() => {
    let stale = false;
    // A refresh keeps what is on screen until the new answer is in, and keeps it if the refresh fails.
    const refresh = clock.tick !== seen && untrack(() => r.data) !== undefined;
    seen = clock.tick;
    if (!refresh) r.data = undefined;
    r.error = '';
    untrack(() => net.busy++);
    fn()
      .then(
        (d) => !stale && (r.data = d),
        (e) => !stale && !refresh && (r.error = message(e)),
      )
      .finally(() => net.busy--);
    return () => (stale = true);
  });
  return r;
}

/** Student data cached by sw.js must not outlive the session on a shared device. */
export function clearApiCache() {
  lookups.clear();
  return 'caches' in window ? caches.delete('api-v1') : Promise.resolve(false);
}

/** Librus mixes numeric and string ids for the same entity; key everything by string. */
export const byId = (list) => new Map((list ?? []).map((x) => [String(x.Id), x]));
