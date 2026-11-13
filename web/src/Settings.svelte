<script>
  import { api, session, message, clearApiCache } from './api.svelte.js';
  import { disable as disablePush } from './push.js';
  import { stored, choiceOf, applyTheme, short, mail, FORCED_KEY, SHORT_KEY, TOUR_KEY, PLUS, MINUS, YEAR, PLAN, THEME, TONES, ATTENDANCE } from './util.js';
  import Icon from './Icon.svelte';
  import Install from './Install.svelte';
  import Lang from './Lang.svelte';
  import { t, locale } from './i18n.js';

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
  const comma = (v) => Number(v).toLocaleString(locale);

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
    if (!confirm(t('Usunąć z serwera wszystko, co o Tobie trzyma, i wylogować Cię na każdym urządzeniu?'))) return;
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
  <h2>{t('Wygląd')}</h2>
  <h3 class="section" id="lang">{t('Język')}</h3>
  <Lang aria-labelledby="lang" />
  <h3 class="section" id="theme">{t('Motyw')}</h3>
  <div class="segmented filter" role="group" aria-labelledby="theme">
    {#each [['', t('Systemowy')], ['light', t('Jasny')], ['dark', t('Ciemny')]] as [v, label] (v)}
      <button aria-pressed={theme === v} onclick={() => pick(THEME, v) && applyTheme((theme = v))}>{label}</button>
    {/each}
  </div>
  <h3 class="section" id="plan">{t('Plan lekcji')}</h3>
  <div class="segmented filter" role="group" aria-labelledby="plan">
    {#each [['', t('Automatycznie')], ['day', t('Dzień')], ['week', t('Tydzień')]] as [v, label] (v)}
      <button aria-pressed={plan === v} onclick={() => pick(PLAN, v) && (plan = v)}>{label}</button>
    {/each}
  </div>
  <p class="muted">
    {t('Automatycznie plan pokazuje dzień na telefonie, a\u00a0tydzień na szerokim ekranie. Przełącznik w\u00a0samym planie zapisuje swój wybór tutaj.')}
  </p>
</section>

<section class="card">
  <h2>{t('Kolory frekwencji')}</h2>
  {#each [...ATTENDANCE] as [std, kind] (std)}
    <h3 class="section" id="tone-{std}">{kind.label}</h3>
    <div class="swatches" role="group" aria-labelledby="tone-{std}">
      {#each TONES as [tone, name] (tone)}
        <button class="chip {tone}" aria-pressed={tones[std] === tone} aria-label={name} title={name} onclick={() => pick(kind, tone) && (tones[std] = tone)}>{kind.sample}</button>
      {/each}
    </div>
  {/each}
  <p class="muted">
    {t('Kolor znaczka przy wpisie we Frekwencji. Rodzaje wpisów, które szkoła dodała sama, zostają szare.')}
    {#if [...ATTENDANCE].some(([std, kind]) => tones[std] !== kind.options[0])}
      <button class="link" onclick={() => [...ATTENDANCE].forEach(([std, kind]) => pick(kind, kind.options[0]) && (tones[std] = kind.options[0]))}>{t('Przywróć domyślne')}</button>
    {/if}
  </p>
</section>

<section class="card">
  <h2>{t('Średnie ocen')}</h2>
  <label class="check">
    <input type="checkbox" checked={forced} onchange={(e) => keep(FORCED_KEY, e.currentTarget)} />
    {t('Licz średnie z każdej oceny 1–6')}
  </label>
  <p class="muted">
    {t('Dla szkoły, która wymaga średniej, a\u00a0oceny wpisuje jako opisowe albo w\u00a0kategoriach nieliczonych do średniej, więc Librus żadnej nie podaje. Aplikacja liczy wtedy sama: każda ocena 1–6 z\u00a0wagą swojej kategorii albo raz, a\u00a0gdy wszystkie wagi przedmiotu to 0, każda raz. Przedmiot oceniany punktami dostaje procent zdobytych punktów, a\u00a0oceniany w\u00a0procentach ich średnią z\u00a0wagami.')}
  </p>
  <h3 class="section" id="plus">{t('Plus przy ocenie')}</h3>
  <div class="segmented filter" role="group" aria-labelledby="plus">
    {#each PLUS.options as v (v)}
      <button aria-pressed={plus === v} onclick={() => pick(PLUS, v) && (plus = v)}>{v === '0' ? t('nic') : `+${comma(v)}`}</button>
    {/each}
  </div>
  <h3 class="section" id="minus">{t('Minus przy ocenie')}</h3>
  <div class="segmented filter" role="group" aria-labelledby="minus">
    {#each MINUS.options as v (v)}
      <button aria-pressed={minus === v} onclick={() => pick(MINUS, v) && (minus = v)}>{v === '0' ? t('nic') : `−${comma(v)}`}</button>
    {/each}
  </div>
  <h3 class="section" id="year">{t('Średnia roczna')}</h3>
  <div class="segmented" role="group" aria-labelledby="year">
    {#each [['all', t('Wszystkie oceny roku')], ['halves', t('Średnia obu semestrów')]] as [v, label] (v)}
      <button aria-pressed={year === v} onclick={() => pick(YEAR, v) && (year = v)}>{label}</button>
    {/each}
  </div>
  <p class="muted">
    {t('Ile plus dodaje do oceny, a\u00a0minus od niej odejmuje, i\u00a0z\u00a0czego jest średnia roczna w\u00a0średnich, które wylicza aplikacja: przy przełączniku wyżej albo gdy szkoła ukrywa średnie. Średnich podanych przez Librusa to nie zmienia. Szkoła może liczyć inaczej.')}
  </p>
</section>

<section class="card">
  <h2>{t('Zrzuty ekranu')}</h2>
  <label class="check">
    <!-- Every name on screen was made before the switch: the page loads again and makes them anew. -->
    <input type="checkbox" checked={short} onchange={(e) => keep(SHORT_KEY, e.currentTarget) && location.reload()} />
    {t('Skróć nazwiska')}
  </label>
  <p class="muted">
    {t('Osoby to imię i\u00a0pierwsza litera nazwiska („Anna N.”), adres e-mail to pierwsza litera i\u00a0domena. Treść wiadomości i\u00a0ogłoszeń zostaje bez zmian. Strona wczyta się od nowa.')}
  </p>
</section>

<p class="muted">{t('Ustawienia wyżej są zapisane na tym urządzeniu, nie na serwerze.')}</p>

<section class="card compose">
  <h2>{t('Aplikacja')}</h2>
  <Install />
  <p class="muted">{t('Samouczek to krótkie oprowadzenie z\u00a0pierwszego uruchomienia. Otworzy się na Starcie.')}</p>
  <button class="secondary" onclick={tour}><Icon name="refresh" size={20} />{t('Pokaż samouczek')}</button>
  <a class="button" href={issues} target="_blank" rel="noopener"><Icon name="flag" size={20} />{t('Zgłoś błąd')}</a>
</section>

<section class="card compose">
  <h2>{t('Konto')}</h2>
  <p class="muted">{t('Zalogowano jako {email}.', { email: mail(session.me.email) })}</p>
  <button class="secondary" onclick={logout}><Icon name="logout" size={20} />{t('Wyloguj')}</button>
  <p class="muted">{t('Usunięcie kasuje z\u00a0serwera wszystko, co o\u00a0Tobie trzyma, i\u00a0wylogowuje Cię na każdym urządzeniu.')}</p>
  {#if forgetError}<p class="error" role="alert">{forgetError}</p>{/if}
  <button class="secondary" onclick={forget}><Icon name="close" size={20} />{t('Usuń moje dane')}</button>
</section>
