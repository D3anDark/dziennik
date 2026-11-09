/** `me` is undefined while booting, null when logged out. */
export const session = $state({ me: undefined });
export const net = $state({ online: navigator.onLine });
addEventListener('online', () => (net.online = true));
addEventListener('offline', () => (net.online = false));

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
};

export const message = (e) => MESSAGES[e?.message] ?? `Błąd: ${e?.message ?? e}`;

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

export const synergia = (login, path) => api(`s/${encodeURIComponent(login)}/${path}`);

/** POST to one of the writes the server allows (Messages, HomeWorkAssignments/MarkAsRead|MarkAsDone). */
export const write = (login, path, data) => post(`s/${encodeURIComponent(login)}/${path}`, data);

/** Unread message count behind the tab badge. Views that read or send messages call `refreshUnread`. */
export const inbox = $state({ login: null, unread: 0 });

let unreadSeq = 0;

export function refreshUnread(login) {
  const seq = ++unreadSeq;
  return synergia(login, 'Messages/Unread').then(
    (r) => seq === unreadSeq && inbox.login === login && (inbox.unread = Number(r.UnreadMessages) || 0),
    () => {}, // badge only: keep the last known count
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
 * and a superseded run never overwrites a newer one. Call during component init.
 * A pre-effect clears `data` before the template re-renders, so markup never sees the previous run's shape.
 */
export function resource(fn) {
  const r = $state({ data: undefined, error: '' });
  $effect.pre(() => {
    let stale = false;
    r.data = undefined;
    r.error = '';
    fn().then(
      (d) => !stale && (r.data = d),
      (e) => !stale && (r.error = message(e)),
    );
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
