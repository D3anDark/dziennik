<script>
  import { api, session, message, clearApiCache } from './api.svelte.js';
  import { disable as disablePush } from './push.js';
  import { stored, choiceOf, applyTheme, short, mail, FORCED_KEY, SHORT_KEY, TOUR_KEY, PLUS, MINUS, YEAR, PLAN, THEME, TONES, ATTENDANCE } from './util.js';
  import Icon from './Icon.svelte';
  import Install from './Install.svelte';

  /**
   * Every switch and choice of the app that is kept on this device (util.js), then what is done with the app and the
   * account. `logout` and `issues` (the bug report form) are App's: its sidebar and "Więcej" use them too.
   */
  let { logout, issues } = $props();
  const forced = stored(FORCED_KEY);
  let plus = $state(choiceOf(PLUS));
  let minus = $state(choiceOf(MINUS));
  let year = $state(choiceOf(YEAR));
  let theme = $state(choiceOf(THEME));
  let plan = $state(choiceOf(PLAN));
  /** The tint of each kind of attendance mark, by the kind's id. */
  let tones = $state(Object.fromEntries([...ATTENDANCE].map(([std, kind]) => [std, choiceOf(kind)])));
  const comma = (v) => v.replace('.', ',');

  /** Writes the switch; without storage it cannot be kept, so the box goes back to what holds. */
  function keep(key, box) {
    try {
      if (box.checked) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
      return true;
    } catch {
      box.checked = !box.checked;
      return false;
    }
  }

  /** Writes the choice, the default by keeping nothing. False without storage: the choice stays as it was. */
  function pick({ key, options }, value) {
    try {
      if (value === options[0]) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  /** The tour opens on a start that has not seen it: the page loads again at Start. */
  function tour() {
    try {
      localStorage.removeItem(TOUR_KEY);
    } catch {
      return;
    }
    location.hash = '#/start';
    location.reload();
  }

  let forgetError = $state('');

  /** RODO art. 17: everything the server keeps about this person goes, on every device. */
  async function forget() {
    if (!confirm('Usunąć z serwera wszystko, co o Tobie trzyma, i wylogować Cię na każdym urządzeniu?')) return;
    forgetError = '';
    await disablePush().catch(() => {});
    try {
      await api('me', { method: 'DELETE' });
    } catch (e) {
      forgetError = message(e);
      return;
    }
    await clearApiCache();
    session.me = null;
  }
</script>

<section class="card">
  <h2>Wygląd</h2>
  <h3 class="section" id="theme">Motyw</h3>
  <div class="segmented filter" role="group" aria-labelledby="theme">
    {#each [['', 'Systemowy'], ['light', 'Jasny'], ['dark', 'Ciemny']] as [v, label] (v)}
      <button aria-pressed={theme === v} onclick={() => pick(THEME, v) && applyTheme((theme = v))}>{label}</button>
    {/each}
  </div>
  <h3 class="section" id="plan">Plan lekcji</h3>
  <div class="segmented filter" role="group" aria-labelledby="plan">
    {#each [['', 'Automatycznie'], ['day', 'Dzień'], ['week', 'Tydzień']] as [v, label] (v)}
      <button aria-pressed={plan === v} onclick={() => pick(PLAN, v) && (plan = v)}>{label}</button>
    {/each}
  </div>
  <p class="muted">
    Automatycznie plan pokazuje dzień na telefonie, a&nbsp;tydzień na szerokim ekranie. Przełącznik w&nbsp;samym planie
    zapisuje swój wybór tutaj.
  </p>
</section>

<section class="card">
  <h2>Kolory frekwencji</h2>
  {#each [...ATTENDANCE] as [std, kind] (std)}
    <h3 class="section" id="tone-{std}">{kind.label}</h3>
    <div class="swatches" role="group" aria-labelledby="tone-{std}">
      {#each TONES as [t, name] (t)}
        <button class="chip {t}" aria-pressed={tones[std] === t} aria-label={name} title={name} onclick={() => pick(kind, t) && (tones[std] = t)}>{kind.sample}</button>
      {/each}
    </div>
  {/each}
  <p class="muted">
    Kolor znaczka przy wpisie we Frekwencji. Rodzaje wpisów, które szkoła dodała sama, zostają szare.
    {#if [...ATTENDANCE].some(([std, kind]) => tones[std] !== kind.options[0])}
      <button class="link" onclick={() => [...ATTENDANCE].forEach(([std, kind]) => pick(kind, kind.options[0]) && (tones[std] = kind.options[0]))}>Przywróć domyślne</button>
    {/if}
  </p>
</section>

<section class="card">
  <h2>Średnie ocen</h2>
  <label class="check">
    <input type="checkbox" checked={forced} onchange={(e) => keep(FORCED_KEY, e.currentTarget)} />
    Licz średnie z każdej oceny 1–6
  </label>
  <p class="muted">
    Dla szkoły, która wymaga średniej, a&nbsp;oceny wpisuje jako opisowe albo w&nbsp;kategoriach nieliczonych do średniej,
    więc Librus żadnej nie podaje. Aplikacja liczy wtedy sama: każda ocena 1–6 z&nbsp;wagą swojej kategorii
    albo raz, a&nbsp;gdy wszystkie wagi przedmiotu to 0, każda raz. Przedmiot oceniany punktami dostaje procent zdobytych
    punktów, a&nbsp;oceniany w&nbsp;procentach ich średnią z&nbsp;wagami.
  </p>
  <h3 class="section" id="plus">Plus przy ocenie</h3>
  <div class="segmented filter" role="group" aria-labelledby="plus">
    {#each PLUS.options as v (v)}
      <button aria-pressed={plus === v} onclick={() => pick(PLUS, v) && (plus = v)}>{v === '0' ? 'nic' : `+${comma(v)}`}</button>
    {/each}
  </div>
  <h3 class="section" id="minus">Minus przy ocenie</h3>
  <div class="segmented filter" role="group" aria-labelledby="minus">
    {#each MINUS.options as v (v)}
      <button aria-pressed={minus === v} onclick={() => pick(MINUS, v) && (minus = v)}>{v === '0' ? 'nic' : `−${comma(v)}`}</button>
    {/each}
  </div>
  <h3 class="section" id="year">Średnia roczna</h3>
  <div class="segmented" role="group" aria-labelledby="year">
    {#each [['all', 'Wszystkie oceny roku'], ['halves', 'Średnia obu semestrów']] as [v, label] (v)}
      <button aria-pressed={year === v} onclick={() => pick(YEAR, v) && (year = v)}>{label}</button>
    {/each}
  </div>
  <p class="muted">
    Ile plus dodaje do oceny, a&nbsp;minus od niej odejmuje, i&nbsp;z&nbsp;czego jest średnia roczna w&nbsp;średnich, które
    wylicza aplikacja: przy przełączniku wyżej albo gdy szkoła ukrywa średnie. Średnich podanych przez Librusa to nie
    zmienia. Szkoła może liczyć inaczej.
  </p>
</section>

<section class="card">
  <h2>Zrzuty ekranu</h2>
  <label class="check">
    <!-- Every name on screen was made before the switch: the page loads again and makes them anew. -->
    <input type="checkbox" checked={short} onchange={(e) => keep(SHORT_KEY, e.currentTarget) && location.reload()} />
    Skróć nazwiska
  </label>
  <p class="muted">
    Osoby to imię i&nbsp;pierwsza litera nazwiska („Anna N.”), adres e-mail to pierwsza litera i&nbsp;domena. Treść
    wiadomości i&nbsp;ogłoszeń zostaje bez zmian. Strona wczyta się od nowa.
  </p>
</section>

<p class="muted">Ustawienia wyżej są zapisane na tym urządzeniu, nie na serwerze.</p>

<section class="card compose">
  <h2>Aplikacja</h2>
  <Install />
  <p class="muted">Samouczek to krótkie oprowadzenie z&nbsp;pierwszego uruchomienia. Otworzy się na Starcie.</p>
  <button class="secondary" onclick={tour}><Icon name="refresh" size={20} />Pokaż samouczek</button>
  <a class="button" href={issues} target="_blank" rel="noopener"><Icon name="flag" size={20} />Zgłoś błąd</a>
</section>

<section class="card compose">
  <h2>Konto</h2>
  <p class="muted">Zalogowano jako {mail(session.me.email)}.</p>
  <button class="secondary" onclick={logout}><Icon name="logout" size={20} />Wyloguj</button>
  <p class="muted">Usunięcie kasuje z&nbsp;serwera wszystko, co o&nbsp;Tobie trzyma, i&nbsp;wylogowuje Cię na każdym urządzeniu.</p>
  {#if forgetError}<p class="error" role="alert">{forgetError}</p>{/if}
  <button class="secondary" onclick={forget}><Icon name="close" size={20} />Usuń moje dane</button>
</section>
