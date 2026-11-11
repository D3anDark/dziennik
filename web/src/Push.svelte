<script>
  import { api, session, message, resource, DEMO } from './api.svelte.js';
  import { fmtUnix, ago } from './util.js';
  import { supported, current, enable, disable } from './push.js';
  import Icon from './Icon.svelte';

  /** `on` is undefined until the browser says whether this device is subscribed. */
  let on = $state(undefined);
  let endpoint = $state('');
  let busy = $state(false);
  let error = $state('');
  /** "4 min temu", "2 godz. temu", "wczoraj", or the date. */
  const since = (t) => ago(t).replace(/(min|godz\.)$/, '$1 temu');
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
    ['oceny', 'Oceny'],
    ['zachowanie', 'Zachowanie'],
    ['frekwencja', 'Nieobecności i spóźnienia'],
    ['uwagi', 'Uwagi'],
    ['wiadomosci', 'Wiadomości'],
    ['ogloszenia', 'Ogłoszenia'],
    ['zadania', 'Zadania domowe'],
    ['terminarz', 'Terminarz'],
    ['plan', 'Zmiany w planie'],
    ['numerek', 'Szczęśliwy numerek'],
    ['przerwy', 'Przerwy: ile trwają i jaka lekcja następna'],
  ];

  /** What the server last heard from Librus, per student. Read again whenever the switch changes. */
  const feeds = resource(() => (on ? api('push') : Promise.resolve({ feeds: [] })));
  /** What this device turned off: its last choice here, else what the server keeps. */
  let chosen = $state(null);
  const off = $derived(chosen ?? feeds.data?.devices?.find((d) => d.endpoint === endpoint)?.off ?? []);

  /** One change at a time (`busy`), so the server keeps the last one. */
  async function choose(kind, wanted) {
    const before = chosen;
    chosen = wanted ? off.filter((k) => k !== kind) : [...off, kind];
    busy = true;
    error = '';
    try {
      await api('push', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, off: chosen }) });
    } catch (e) {
      chosen = before;
      error = message(e);
    } finally {
      busy = false;
    }
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
  <h2>Na tym urządzeniu</h2>
  {#if DEMO}
    <p class="muted">W wersji demonstracyjnej powiadomień nie ma: wysyła je serwer aplikacji.</p>
  {:else if !supported}
    <p class="muted">
      Ta przeglądarka nie obsługuje powiadomień. Na iPhonie i iPadzie dodaj najpierw aplikację do ekranu początkowego
      (Udostępnij, potem „Do ekranu początkowego”) i otwórz ją stamtąd.
    </p>
  {:else if blocked}
    <p class="note-line"><Icon name="bell-off" size={18} />Zablokowane w ustawieniach przeglądarki. Odblokuj powiadomienia dla tej strony i wróć tutaj.</p>
  {:else if on !== undefined}
    {#if on}<p class="note-line"><Icon name="done" size={18} />Włączone.</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button class={on ? 'secondary' : 'primary'} disabled={busy} onclick={toggle}>
      <Icon name={on ? 'bell-off' : 'bell'} size={20} />{on ? 'Wyłącz' : 'Włącz powiadomienia'}
    </button>
  {/if}
  <p class="byline">
    <!-- &nbsp; after one-letter words: Polish leaves none at a line's end. -->
    Powiadomienia o nowych ocenach, nieobecnościach, uwagach, wiadomościach, ogłoszeniach, zmianach w&nbsp;planie
    i&nbsp;terminarzu, o&nbsp;szczęśliwym numerku i&nbsp;o&nbsp;przerwach. Serwer pyta Librusa o&nbsp;nowości co 10 minut. Żeby to
    robić, gdy aplikacja jest zamknięta, trzyma wtedy kopię Twojego dostępu do Librusa, którą otwiera sam, i&nbsp;historię
    zmian. Wyłączenie powiadomień na ostatnim urządzeniu usuwa jedno i&nbsp;drugie.
  </p>
</section>

{#if on && endpoint}
  <section class="card">
    <h2>Rodzaje</h2>
    {#each KINDS as [kind, label] (kind)}
      <label class="check">
        <input type="checkbox" disabled={busy} checked={!off.includes(kind)} onchange={(e) => choose(kind, e.currentTarget.checked)} />
        {label}
      </label>
    {/each}
  </section>
{/if}

{#if on && students.length}
  <section class="card">
    <h2>Stan</h2>
    <ul class="entries access">
      {#each students as s (s.login)}
        <li>
          <span class="grow">
            {s.name ?? s.login}
            <small class={s.feed?.error ? 'error' : 'muted'}>
              {#if !s.feed}
                Czeka na pierwsze sprawdzenie.
              {:else if s.feed.error === 'relogin'}
                Sesja Librusa wygasła.
              {:else if s.feed.error}
                {message(new Error(s.feed.error))}
              {:else}
                Sprawdzono <time title={fmtUnix(s.feed.checked)}>{since(s.feed.checked)}</time>.
              {/if}
            </small>
          </span>
          <!-- The server cannot sign in to Librus again by itself: that takes the password, on the sign-in form. -->
          {#if s.feed?.error === 'relogin'}<button class="secondary" onclick={() => (session.me = null)}>Zaloguj ponownie</button>{/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
