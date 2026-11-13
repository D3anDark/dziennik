<script>
  import { api, session, message, resource, DEMO } from './api.svelte.js';
  import { fmtUnix, ago, alias } from './util.js';
  import { supported, current, enable, disable } from './push.js';
  import Icon from './Icon.svelte';
  import { t } from './i18n.js';

  /** `on` is undefined until the browser says whether this device is subscribed. */
  let on = $state(undefined);
  let endpoint = $state('');
  let busy = $state(false);
  let error = $state('');
  const blocked = $derived(supported && on !== undefined && Notification.permission === 'denied');

  current().then(
    (sub) => {
      on = Boolean(sub) && Notification.permission === 'granted';
      endpoint = sub?.endpoint ?? '';
    },
    () => (on = false),
  );

  /** The groups of `watch::GROUPS` on the server, in its order. */
  const KINDS = [
    ['oceny', t('Oceny')],
    ['zachowanie', t('Zachowanie')],
    ['frekwencja', t('Nieobecności i spóźnienia')],
    ['uwagi', t('Uwagi')],
    ['wiadomosci', t('Wiadomości')],
    ['ogloszenia', t('Ogłoszenia')],
    ['zadania', t('Zadania domowe')],
    ['terminarz', t('Terminarz')],
    ['plan', t('Zmiany w planie')],
    ['numerek', t('Szczęśliwy numerek')],
    ['przerwy', t('Przerwy: ile trwają i jaka lekcja następna')],
  ];

  /** What the server last heard from Librus, per student. Read again whenever the switch changes. */
  const feeds = resource(() => (on ? api('push') : Promise.resolve({ feeds: [] })));
  /** What this device turned off: its last choice here, else what the server keeps. */
  let chosen = $state(null);
  const off = $derived(chosen ?? feeds.data?.devices?.find((d) => d.endpoint === endpoint)?.off ?? []);

  /**
   * The hours this device gets nothing, "22:00-07:00" in Polish time ('' for none): its last choice here, else what
   * the server keeps.
   */
  let hushed = $state(null);
  const quiet = $derived(hushed ?? feeds.data?.devices?.find((d) => d.endpoint === endpoint)?.quiet ?? '');
  const hours = $derived(quiet ? quiet.split('-') : ['22:00', '07:00']);

  /** One change at a time (`busy`), so the server keeps the last one; `undo` takes a refused one back. */
  async function save(settings, undo) {
    busy = true;
    error = '';
    try {
      await api('push', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, ...settings }) });
    } catch (e) {
      undo();
      error = message(e);
    } finally {
      busy = false;
    }
  }

  function choose(kind, wanted) {
    const before = chosen;
    chosen = wanted ? off.filter((k) => k !== kind) : [...off, kind];
    return save({ off: chosen }, () => (chosen = before));
  }

  /** The request sets what is off as well, so it carries that along. A field emptied half-way is not a choice yet. */
  function hush(from, to) {
    if (from === undefined) from = to = '';
    else if (!from || !to) return;
    else if (from === to) return void (error = t('Cisza nie może zaczynać się i\u00a0kończyć o\u00a0tej samej godzinie.'));
    const before = hushed;
    hushed = from && `${from}-${to}`;
    return save({ off, quiet: hushed }, () => (hushed = before));
  }

  const students = $derived(
    (session.me?.accounts ?? []).map((a) => ({ ...a, feed: (feeds.data?.feeds ?? []).find((f) => f.login === a.login) })),
  );

  async function toggle() {
    busy = true;
    error = '';
    try {
      await (on ? disable() : enable(session.me.push));
      on = !on;
      endpoint = (await current())?.endpoint ?? '';
      chosen = null;
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
</script>

<!-- The state and its switch first; what the notifications cover is the fine print under them. -->
<section class="card compose">
  <h2>{t('Na tym urządzeniu')}</h2>
  {#if DEMO}
    <p class="muted">{t('W wersji demonstracyjnej powiadomień nie ma: wysyła je serwer aplikacji.')}</p>
  {:else if !supported}
    <p class="muted">
      {t('Ta przeglądarka nie obsługuje powiadomień. Na iPhonie i iPadzie dodaj najpierw aplikację do ekranu początkowego (Udostępnij, potem „Do ekranu początkowego”) i otwórz ją stamtąd.')}
    </p>
  {:else if blocked}
    <p class="note-line"><Icon name="bell-off" size={18} />{t('Zablokowane w ustawieniach przeglądarki. Odblokuj powiadomienia dla tej strony i wróć tutaj.')}</p>
  {:else if on !== undefined}
    {#if on}<p class="note-line"><Icon name="done" size={18} />{t('Włączone.')}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button class={on ? 'secondary' : 'primary'} disabled={busy} onclick={toggle}>
      <Icon name={on ? 'bell-off' : 'bell'} size={20} />{on ? t('Wyłącz') : t('Włącz powiadomienia')}
    </button>
  {/if}
  <p class="byline">
    <!-- &nbsp; after one-letter words: Polish leaves none at a line's end. -->
    {t('Powiadomienia o nowych ocenach, nieobecnościach, uwagach, wiadomościach, ogłoszeniach, zmianach w\u00a0planie i\u00a0terminarzu, o\u00a0szczęśliwym numerku i\u00a0o\u00a0przerwach. Serwer pyta Librusa o\u00a0nowości co 10 minut. Żeby to robić, gdy aplikacja jest zamknięta, trzyma wtedy kopię Twojego dostępu do Librusa, którą otwiera sam, i\u00a0historię zmian. Wyłączenie powiadomień na ostatnim urządzeniu usuwa jedno i\u00a0drugie.')}
  </p>
</section>

{#if on && endpoint}
  <section class="card">
    <h2>{t('Rodzaje')}</h2>
    {#each KINDS as [kind, label] (kind)}
      <label class="check">
        <input type="checkbox" disabled={busy} checked={!off.includes(kind)} onchange={(e) => choose(kind, e.currentTarget.checked)} />
        {label}
      </label>
    {/each}
  </section>
  <section class="card">
    <h2>{t('Cisza nocna')}</h2>
    <label class="check">
      <input type="checkbox" disabled={busy} checked={Boolean(quiet)} onchange={(e) => (e.currentTarget.checked ? hush(...hours) : hush())} />
      {t('Nie wysyłaj w\u00a0wybranych godzinach')}
    </label>
    {#if quiet}
      <div class="hours">
        <label>{t('Od')}<input type="time" required disabled={busy} value={hours[0]} onchange={(e) => hush(e.currentTarget.value, hours[1])} /></label>
        <label>{t('Do')}<input type="time" required disabled={busy} value={hours[1]} onchange={(e) => hush(hours[0], e.currentTarget.value)} /></label>
      </div>
    {/if}
    <p class="muted">
      {t('W\u00a0tych godzinach serwer nic nie wysyła na to urządzenie. Tego, co wtedy przyszło, nie wyśle później: zobaczysz to w\u00a0Aktywności. Godziny są w\u00a0czasie polskim.')}
    </p>
  </section>
{/if}

{#if on && students.length}
  <section class="card">
    <h2>{t('Stan')}</h2>
    <ul class="entries access">
      {#each students as s (s.login)}
        <li>
          <span class="grow">
            {s.name ? alias(s.name) : s.login}
            <small class={s.feed?.error ? 'error' : 'muted'}>
              {#if !s.feed}
                {t('Czeka na pierwsze sprawdzenie.')}
              {:else if s.feed.error === 'relogin'}
                {t('Sesja Librusa wygasła.')}
              {:else if s.feed.error}
                {message(new Error(s.feed.error))}
              {:else}
                {t('Sprawdzono')} <time title={fmtUnix(s.feed.checked)}>{ago(s.feed.checked, true)}</time>.
              {/if}
            </small>
          </span>
          <!-- The server cannot sign in to Librus again by itself: that takes the password, on the sign-in form. -->
          {#if s.feed?.error === 'relogin'}<button class="secondary" onclick={() => (session.me = null)}>{t('Zaloguj ponownie')}</button>{/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
