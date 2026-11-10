<script>
  import { api, session, message, resource } from './api.svelte.js';
  import { fmtUnix } from './util.js';
  import { supported, current, enable, disable } from './push.js';
  import Icon from './Icon.svelte';

  /** `on` is undefined until the browser says whether this device is subscribed. */
  let on = $state(undefined);
  let busy = $state(false);
  let error = $state('');
  const blocked = $derived(supported && on !== undefined && Notification.permission === 'denied');

  current().then(
    (sub) => (on = Boolean(sub) && Notification.permission === 'granted'),
    () => (on = false),
  );

  /** What the server last heard from Librus, per student. Read again whenever the switch changes. */
  const feeds = resource(() => (on ? api('push') : Promise.resolve({ feeds: [] })));
  const students = $derived(
    (session.me?.accounts ?? []).map((a) => ({ ...a, feed: (feeds.data?.feeds ?? []).find((f) => f.login === a.login) })),
  );

  async function toggle() {
    busy = true;
    error = '';
    try {
      await (on ? disable() : enable(session.me.push));
      on = !on;
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="card compose">
  <p>
    Powiadomienia o nowych ocenach, nieobecnościach, uwagach, wiadomościach, ogłoszeniach oraz zmianach w planie i
    terminarzu. Serwer pyta Librusa o nowości co 10 minut.
  </p>
  {#if !supported}
    <p class="muted">
      Ta przeglądarka nie obsługuje powiadomień. Na iPhonie i iPadzie dodaj najpierw aplikację do ekranu początkowego
      (Udostępnij, potem „Do ekranu początkowego”) i otwórz ją stamtąd.
    </p>
  {:else if blocked}
    <p class="muted">Powiadomienia z tej strony są zablokowane w ustawieniach przeglądarki. Odblokuj je i wróć tutaj.</p>
  {:else if on !== undefined}
    {#if on}<p class="note-line"><Icon name="done" size={18} />Włączone na tym urządzeniu.</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button class={on ? 'secondary' : 'primary'} disabled={busy} onclick={toggle}>
      <Icon name="bell" size={20} />{on ? 'Wyłącz na tym urządzeniu' : 'Włącz powiadomienia'}
    </button>
  {/if}
</section>

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
              {:else if s.feed.error}
                {message(new Error(s.feed.error))}
              {:else}
                Sprawdzono {fmtUnix(s.feed.checked)}.
              {/if}
            </small>
          </span>
        </li>
      {/each}
    </ul>
  </section>
{/if}
