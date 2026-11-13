<script>
  import { synergia, resource, inbox, clock } from './api.svelte.js';
  import { today, mondayOf, shift, fmtDay, fmtDate, plural } from './util.js';
  import { week, monthEvents, grades, upcomingDay, unseenGrades } from './data.js';
  import Async from './Async.svelte';
  import Icon from './Icon.svelte';
  import Lessons from './Lessons.svelte';
  import Events from './Events.svelte';
  import Activity from './Activity.svelte';
  import Mark from './Mark.svelte';
  import { t } from './i18n.js';

  let { login } = $props();
  const todayIso = today();
  const AHEAD = 14;
  const greeting = $derived((clock.tick, new Date().getHours() < 18 ? t('Dzień dobry') : t('Dobry wieczór')));

  /** Today until its last lesson ends, then the next day with lessons, looking into next week if need be. */
  async function nextDay(login) {
    for (const start of [mondayOf(todayIso), shift(mondayOf(todayIso), 7)]) {
      const day = upcomingDay(await week(login, start));
      if (day) return day;
    }
    return null;
  }

  const tomorrow = shift(todayIso, 1);
  const dayName = (date) => (date === todayIso ? t('Dziś') : date === tomorrow ? t('Jutro') : fmtDay(date));

  /** When a grade was put in; a grade without that date counts from its own date. Sorted and shown by the same. */
  const addedAt = (g) => g.added || g.date || '';
  /** A final grade's kind beside its subject, without the word "grade". */
  const KINDS = {
    [t('Ocena roczna')]: t('roczna'),
    [t('Ocena semestralna')]: t('semestralna'),
    [t('Proponowana roczna')]: t('proponowana roczna'),
    [t('Proponowana semestralna')]: t('proponowana semestralna'),
  };

  /** The newest grades, and how many arrived in the last week. */
  async function recentGrades(login) {
    const all = [...(await grades(login)).items].sort((a, b) => addedAt(b).localeCompare(addedAt(a)));
    return { list: all.slice(0, 8), week: unseenGrades(login, all).size };
  }

  async function upcoming(login) {
    const end = shift(todayIso, AHEAD);
    const [y, m] = [Number(todayIso.slice(0, 4)), Number(todayIso.slice(5, 7))];
    const next = new Date(y, m, 1);
    const months = [[y, m]];
    if (end.slice(0, 7) !== todayIso.slice(0, 7)) months.push([next.getFullYear(), next.getMonth() + 1]);
    const all = (await Promise.all(months.map(([yy, mm]) => monthEvents(login, yy, mm)))).flat();
    return all.filter((e) => (e.to || e.date) >= todayIso && e.date <= end);
  }

  const day = resource(() => nextDay(login), () => `next-day/${login}/${todayIso}`);
  const recent = resource(() => recentGrades(login), () => `recent/${login}/${todayIso}`);
  const events = resource(() => upcoming(login), () => `upcoming/${login}/${todayIso}`);
  const news = $derived(
    [
      ['#/wiadomosci', inbox.unread, (n) => plural(n, ['nowa wiadomość', 'nowe wiadomości', 'nowych wiadomości'])],
      ['#/oceny', recent.data?.week, (n) => plural(n, ['nowa ocena', 'nowe oceny', 'nowych ocen'])],
    ]
      .filter(([, n]) => n > 0)
      .map(([href, n, word]) => [href, n, word(n)]),
  );
  // Optional: a school without lucky numbers answers with an error, and the line just leaves it out.
  const lucky = resource(
    () => synergia(login, 'LuckyNumbers').then((r) => r.LuckyNumber?.LuckyNumber ?? null, () => null),
    () => `lucky/${login}/${todayIso}`,
  );
</script>

<header class="greeting">
  <h1 tabindex="-1">{greeting}</h1>
  <p class="muted">
    {fmtDay(todayIso)}{#if lucky.data}{' · '}<span class="lucky">{t('Szczęśliwy numerek')} <strong>{lucky.data}</strong></span>{/if}
  </p>
  <!-- Each a way into its page. A zero, or a count still loading, is left out rather than shown as a figure.
       Today's lessons and the coming events are not counted here: the panels below list them. -->
  {#if news.length}
    <p class="news">
      {#each news as [href, n, word], i (href)}{#if i}{' · '}{/if}<a {href}><strong class="new">{n}</strong> {word}</a>{/each}
    </p>
  {/if}
</header>

<!-- Two columns on a wide screen, each a stack of panels at their own height. -->
<div class="panels">
  <div class="col">
    <section class="card">
      <div class="head">
        <h2>{dayName(day.data?.date ?? todayIso)}</h2>
        <a href="#/plan">{t('Cały plan')}<Icon name="right" size={14} /></a>
      </div>
      <Async r={day}>
        {#snippet children(d)}
          {#if d}
            <Lessons lessons={d.lessons} live={d.date === todayIso} />
          {:else}
            <p class="muted">{t('Brak lekcji w najbliższych dniach.')}</p>
          {/if}
        {/snippet}
      </Async>
    </section>

    <section class="card">
      <div class="head">
        <h2>{t('Ostatnie oceny')}</h2>
        <a href="#/oceny">{t('Wszystkie oceny')}<Icon name="right" size={14} /></a>
      </div>
      <Async r={recent}>
        {#snippet children(r)}
          {#if r.list.length}
            <ul class="entries recent">
              {#each r.list as g (g.id)}
                <li>
                  <span class="chip static {g.tone}" class:final={g.kind}><Mark value={g.value} was={g.was} /></span>
                  <span>{g.name}{#if g.kind}<span class="muted">{' · '}{KINDS[g.kind]}</span>{/if}</span>
                  <span class="muted">{fmtDate(addedAt(g))}</span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="muted">{t('Brak ocen.')}</p>
          {/if}
        {/snippet}
      </Async>
    </section>
  </div>

  <div class="col">
    <section class="card">
      <div class="head">
        <h2>{t('Najbliższe {n} dni', { n: AHEAD })}</h2>
        <a href="#/terminarz">{t('Terminarz')}<Icon name="right" size={14} /></a>
      </div>
      <Async r={events} empty={t('Nic zaplanowanego.')}>
        {#snippet children(list)}
          <Events events={list} today={todayIso} flat />
        {/snippet}
      </Async>
    </section>

    <section class="card">
      <div class="head">
        <h2>{t('Aktywność')}</h2>
        <a href="#/aktywnosc">{t('Cała aktywność')}<Icon name="right" size={14} /></a>
      </div>
      <Activity {login} limit={5} />
    </section>
  </div>
</div>
