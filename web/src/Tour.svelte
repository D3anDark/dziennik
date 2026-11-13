<script>
  import { tick } from 'svelte';
  import { session, message, install, byHand, android, DEMO } from './api.svelte.js';
  import { TOUR_KEY } from './util.js';
  import { supported, current, enable } from './push.js';
  import Icon from './Icon.svelte';
  import Install from './Install.svelte';
  import { t } from './i18n.js';

  /**
   * The first-start tour: step by step it lights up each part of the app and says what it is for, then offers to
   * install the app and to turn notifications on. Once per device; closed any way (Pomiń, Esc, Zaczynamy) it does not
   * come back. `at` lists where a step points, phone and desktop alike: the first place on screen is lit, `null` is the
   * middle of the screen, and a step with no place on screen, or whose `when` says no, is left out.
   */
  const STEPS = [
    { at: [null], title: t('Witaj w\u00a0Dzienniku'), text: t('Pokażę w\u00a0kilku krokach, gdzie co jest i\u00a0jak z\u00a0tego korzystać.') },
    { at: ['.tabs a[href="#/start"]', '.side a[href="#/start"]'], title: t('Start'), text: t('Dzisiejsze lekcje, nowe oceny, najbliższe terminy i\u00a0ostatnie zmiany na jednym ekranie.') },
    { at: ['.tabs a[href="#/oceny"]', '.side a[href="#/oceny"]'], title: t('Oceny'), text: t('Oceny ze wszystkich przedmiotów. Nowe są wyróżnione, a\u00a0po wybraniu oceny widać jej szczegóły.') },
    { at: ['.tabs a[href="#/plan"]', '.side a[href="#/plan"]'], title: t('Plan'), text: t('Lekcje na dziś albo na cały tydzień, z\u00a0zastępstwami i\u00a0odwołanymi lekcjami.') },
    { at: ['.tabs a[href="#/wiadomosci"]', '.side a[href="#/wiadomosci"]'], title: t('Wiadomości'), text: t('Wiadomości ze szkoły. Tu też napiszesz nową i\u00a0odpowiesz.') },
    { at: ['.tabs a[href="#/wiecej"]'], title: t('Więcej'), text: t('Reszta dziennika: frekwencja, terminarz, zadania domowe, tematy lekcji, ogłoszenia, uwagi i\u00a0zachowanie. Niżej konto: powiadomienia, ustawienia, prywatność, zgłaszanie błędów i\u00a0wylogowanie.') },
    { at: ['.side nav'], title: t('Reszta dziennika'), text: t('Frekwencja, terminarz, zadania domowe, tematy lekcji, ogłoszenia, uwagi i\u00a0zachowanie. Niżej konto: powiadomienia i\u00a0prywatność, a\u00a0na dole ustawienia.') },
    { at: ['.bar .picker', '.bar .student', '.side .accounts'], title: t('Uczeń'), text: t('Tu widać, czyj dziennik oglądasz. Gdy uczniów jest kilku, tu ich przełączasz.') },
    { at: [`.bar [aria-label="${t('Odśwież')}"]`, `.side [aria-label="${t('Odśwież')}"]`], title: t('Odświeżanie'), text: t('Pobiera najnowsze dane z\u00a0Librusa.') },
    { at: [`.side .me [aria-label="${t('Zgłoś błąd')}"]`], title: t('Zgłoś błąd'), text: t('Coś nie działa? Tu otworzysz formularz zgłoszenia. Jest publiczny, więc nie wpisuj w\u00a0nim danych ze szkoły.') },
    {
      at: ['.side-foot .nav-row', '.tabs a[href="#/wiecej"]', null],
      title: t('Zainstaluj aplikację'),
      text: t('Będzie na ekranie jak każda inna aplikacja, bez paska przeglądarki. Na iPhonie i\u00a0iPadzie dopiero wtedy działają powiadomienia. Później znajdziesz to tutaj.'),
      when: () => Boolean(install.event) || byHand || android,
      action: 'install',
    },
    {
      at: ['.side a[href="#/powiadomienia"]', '.tabs a[href="#/wiecej"]', null],
      title: t('Powiadomienia'),
      // The same terms as the Powiadomienia page: turning them on here keeps a copy of the Librus access on the server.
      text: t('Aplikacja da znać o\u00a0nowych ocenach, nieobecnościach, uwagach, wiadomościach i\u00a0zmianach w\u00a0planie, także gdy jest zamknięta. Serwer trzyma wtedy kopię Twojego dostępu do Librusa i\u00a0historię zmian. Wyłączenie powiadomień na ostatnim urządzeniu usuwa jedno i\u00a0drugie. Później zmienisz to tutaj.'),
      when: (pushOff) => pushOff,
      action: 'push',
    },
  ];
  const MARGIN = 16;
  const GAP = 12;
  const PAD = 4;

  let seen = $state(stored());
  let steps = $state([]);
  let i = $state(0);
  let rect = $state(null);
  let view = $state({ w: innerWidth, h: innerHeight });
  let push = $state({ busy: false, on: false, error: '' });
  let dialog = $state();
  let primary = $state();

  const step = $derived(steps[i]);
  const last = $derived(i === steps.length - 1);
  const width = $derived(Math.min(view.w - 2 * MARGIN, 360));
  const spot = $derived(
    rect
      ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD }
      : { top: view.h / 2, left: view.w / 2, width: 0, height: 0 },
  );
  const card = $derived(place(rect, view, width));

  // Storage that cannot be read: no tour rather than one on every start.
  function stored() {
    try {
      return localStorage.getItem(TOUR_KEY) !== null;
    } catch {
      return true;
    }
  }

  const onScreen = (sel) => document.querySelector(sel)?.getClientRects().length > 0;

  /** Beside a narrow target when there is room (the desktop sidebar), else under or over it, else mid-screen. */
  function place(r, v, w) {
    if (!r) return { left: (v.w - w) / 2, top: '50%', translate: '0 -50%' };
    const px = (n) => `${Math.round(n)}px`;
    const upper = r.top + r.height / 2 < v.h / 2;
    if (v.w - r.right >= w + PAD + GAP + MARGIN) {
      const left = r.right + PAD + GAP;
      return upper ? { left, top: px(Math.max(MARGIN, r.top - PAD)) } : { left, bottom: px(Math.max(MARGIN, v.h - r.bottom - PAD)) };
    }
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, MARGIN), v.w - w - MARGIN);
    return upper ? { left, top: px(r.bottom + PAD + GAP) } : { left, bottom: px(v.h - r.top + PAD + GAP) };
  }

  function measure() {
    view = { w: innerWidth, h: innerHeight };
    const r = step?.at && document.querySelector(step.at)?.getBoundingClientRect();
    // A target hidden since (the window crossed into the other layout) leaves the step mid-screen.
    rect = r?.width ? r : null;
  }

  async function go(n) {
    i = n;
    measure();
    await tick();
    // A button that went away with the step (Wstecz on the first) takes the focus with it.
    if (!dialog.contains(document.activeElement)) primary.focus();
  }

  async function open(d) {
    const sub = supported && !DEMO ? await current().catch(() => null) : null;
    const pushOff = supported && !DEMO && Notification.permission !== 'denied' && !(sub && Notification.permission === 'granted');
    steps = STEPS.filter((s) => !s.when || s.when(pushOff))
      .map((s) => ({ ...s, at: s.at.find((a) => a === null || onScreen(a)) }))
      .filter((s) => s.at !== undefined);
    measure();
    await tick();
    d.showModal();
    primary.focus();
  }

  async function enablePush() {
    push.busy = true;
    push.error = '';
    try {
      await enable(session.me.push);
      push.on = true;
    } catch (e) {
      push.error = message(e);
    } finally {
      push.busy = false;
    }
  }

  function done() {
    seen = true;
    try {
      localStorage.setItem(TOUR_KEY, '1');
    } catch {
      // Not remembered: it shows again next time, nothing else is lost.
    }
  }
</script>

<svelte:window onresize={measure} />

{#if !seen}
  <dialog class="tour" aria-labelledby="tour-title" aria-describedby="tour-text" bind:this={dialog} {@attach (d) => void open(d)} onclose={done}>
    {#if step}
      <div class="spot" style:top="{spot.top}px" style:left="{spot.left}px" style:width="{spot.width}px" style:height="{spot.height}px"></div>
      <div class="step" style:width="{width}px" style:left="{card.left}px" style:top={card.top} style:bottom={card.bottom} style:translate={card.translate}>
        <div aria-live="polite">
          <small class="muted">{t('{i} z\u00a0{n}', { i: i + 1, n: steps.length })}</small>
          <h2 id="tour-title">{step.title}</h2>
          <p id="tour-text">{step.text}</p>
        </div>
        {#if step.action === 'install'}
          <Install />
        {:else if step.action === 'push'}
          {#if push.on}
            <p class="note-line"><Icon name="done" size={18} />{t('Włączone.')}</p>
          {:else}
            <button class="secondary wide" disabled={push.busy} onclick={enablePush}><Icon name="bell" size={20} />{t('Włącz powiadomienia')}</button>
          {/if}
          {#if push.error}<p class="error" role="alert">{push.error}</p>{/if}
        {/if}
        <div class="actions">
          {#if !last}<button class="link" onclick={() => dialog.close()}>{t('Pomiń')}</button>{/if}
          {#if i}<button onclick={() => go(i - 1)}>{t('Wstecz')}</button>{/if}
          <button class="primary" bind:this={primary} onclick={() => (last ? dialog.close() : go(i + 1))}>{last ? t('Zaczynamy') : i ? t('Dalej') : t('Pokaż')}</button>
        </div>
      </div>
    {/if}
  </dialog>
{/if}
