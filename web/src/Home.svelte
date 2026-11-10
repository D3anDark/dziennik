<script>
  import { synergia, resource, inbox, session, clock } from './api.svelte.js';
  import { today, mondayOf, shift, parse, fmtDay, fmtDate } from './util.js';
  import { week, monthEvents, grades, upcomingDay } from './data.js';
  import Async from './Async.svelte';
  import Lessons from './Lessons.svelte';
  import Events from './Events.svelte';
  import Activity from './Activity.svelte';

  let { login } = $props();
  const t = today();
  const AHEAD = 14;
  const student = $derived(session.me?.accounts.find((a) => a.login === login)?.name ?? '');
  const greeting = $derived((clock.tick, new Date().getHours() < 18 ? 'Dzień dobry' : 'Dobry wieczór'));

  /** Today until its last lesson ends, then the next day with lessons, looking into next week if need be. */
  async function nextDay(login) {
    for (const start of [mondayOf(t), shift(mondayOf(t), 7)]) {
      const day = upcomingDay(await week(login, start));
      if (day) return day;
    }
    return null;
  }

  const tomorrow = shift(t, 1);
  const dayName = (date) => (date === t ? 'Dziś' : date === tomorrow ? 'Jutro' : fmtDay(date));

  /** The newest grades, and how many arrived in the last week. */
  async function recentGrades(login) {
    const all = [...(await grades(login)).items].sort((a, b) => b.added.localeCompare(a.added));
    return { list: all.slice(0, 8), week: all.filter((g) => g.added.slice(0, 10) > shift(t, -7)).length };
  }

  async function upcoming(login) {
    const end = shift(t, AHEAD);
    const [y, m] = [Number(t.slice(0, 4)), Number(t.slice(5, 7))];
    const next = new Date(y, m, 1);
    const months = [[y, m]];
    if (end.slice(0, 7) !== t.slice(0, 7)) months.push([next.getFullYear(), next.getMonth() + 1]);
    const all = (await Promise.all(months.map(([yy, mm]) => monthEvents(login, yy, mm)))).flat();
    return all.filter((e) => (e.to || e.date) >= t && e.date <= end);
  }

  const day = resource(() => nextDay(login));
  const recent = resource(() => recentGrades(login));
  const events = resource(() => upcoming(login));
  // Optional: a school without lucky numbers answers with an error, and the line just leaves it out.
  const lucky = resource(() => synergia(login, 'LuckyNumbers').then((r) => r.LuckyNumber?.LuckyNumber ?? null, () => null));

  /** The lessons tile follows the same day as the panel: today's next lesson, or when the next school day starts. */
  const lessons = $derived.by(() => {
    const d = day.data;
    if (d === undefined) return {};
    if (!d) return { label: 'Najbliższe lekcje', count: 0, note: 'brak w planie' };
    const on = d.lessons.filter((l) => !l.IsCanceled);
    if (d.date === t) {
      const next = on.find((l) => l.HourTo > new Date().toTimeString().slice(0, 5));
      return { label: 'Lekcje dziś', count: on.length, note: `${next.HourFrom} ${next.Subject?.Name ?? ''}` };
    }
    const from = `od ${on[0].HourFrom}`;
    if (d.date === tomorrow) return { label: 'Lekcje jutro', count: on.length, note: from };
    return { label: 'Najbliższe lekcje', count: on.length, note: `${parse(d.date).toLocaleDateString('pl-PL', { weekday: 'long' })}, ${from}` };
  });
</script>

<header class="greeting">
  <h1>{greeting}</h1>
  <p class="muted">
    {[fmtDay(t), student, lucky.data && `szczęśliwy numerek ${lucky.data}`].filter(Boolean).join(' · ')}
  </p>
</header>

<!-- A figure still loading is a grey dash, never a zero that would pass for an answer. -->
{#snippet tile(href, label, value, note)}
  <li>
    <a {href}>
      <span>{label}</span>
      <strong class:none={value === undefined}>{value ?? '–'}</strong>
      <small>{note ?? ''}</small>
    </a>
  </li>
{/snippet}

<ul class="tiles">
  {@render tile('#/wiadomosci', 'Nieprzeczytane', inbox.unread, 'wiadomości')}
  {@render tile('#/plan', lessons.label ?? 'Lekcje', lessons.count, lessons.note)}
  {@render tile('#/oceny', 'Nowe oceny', recent.data?.week, 'z ostatnich 7 dni')}
  {@render tile('#/terminarz', 'Terminarz', events.data?.length, `w ciągu ${AHEAD} dni`)}
</ul>

<div class="panels">
  <section class="card" class:today={day.data?.date === t}>
    <div class="head">
      <h2>{dayName(day.data?.date ?? t)}</h2>
      <a href="#/plan">Cały plan</a>
    </div>
    <Async r={day}>
      {#snippet children(d)}
        {#if d}
          <Lessons lessons={d.lessons} live={d.date === t} />
        {:else}
          <p class="muted">Brak lekcji w najbliższych dniach.</p>
        {/if}
      {/snippet}
    </Async>
  </section>

  <section class="card">
    <div class="head">
      <h2>Aktywność</h2>
      <a href="#/aktywnosc">Cała aktywność</a>
    </div>
    <Activity {login} limit={5} />
  </section>

  <section class="card">
    <div class="head">
      <h2>Ostatnie oceny</h2>
      <a href="#/oceny">Wszystkie oceny</a>
    </div>
    <Async r={recent}>
      {#snippet children(r)}
        {#if r.list.length}
          <ul class="entries">
            {#each r.list as g (g.id)}
              <li>
                <span class="chip static {g.tone}">{g.value}</span>
                <span>{g.name}</span>
                <span class="muted">{fmtDate(g.date)}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="muted">Brak ocen.</p>
        {/if}
      {/snippet}
    </Async>
  </section>

  <section class="card">
    <div class="head">
      <h2>Najbliższe {AHEAD} dni</h2>
      <a href="#/terminarz">Terminarz</a>
    </div>
    <Async r={events} empty="Nic zaplanowanego.">
      {#snippet children(list)}
        <Events events={list} today={t} flat />
      {/snippet}
    </Async>
  </section>
</div>
