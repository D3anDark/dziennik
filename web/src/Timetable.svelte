<script>
  import { resource } from './api.svelte.js';
  import Icon from './Icon.svelte';
  import { today, mondayOf, shift, fmtDay, parse } from './util.js';
  import { week as loadWeek, upcomingDay } from './data.js';
  import { swipe } from './swipe.js';
  import Async from './Async.svelte';
  import Lessons from './Lessons.svelte';

  let { login } = $props();

  const t = today();
  const thisMonday = mondayOf(t);
  const VIEW_KEY = 'plan-view';

  /** One day or the whole week, remembered on this device. Unset, a phone shows a day and a wide screen the week. */
  let view = $state(readView() ?? (matchMedia('(min-width: 900px)').matches ? 'week' : 'day'));
  function readView() {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === 'day' || v === 'week' ? v : undefined;
    } catch {
      return undefined;
    }
  }
  function show(v) {
    view = v;
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // private mode: the choice just is not remembered
    }
  }

  /** The day the view is about; its week is the one loaded. */
  let day = $state(t);
  const week = $derived(mondayOf(day));
  const days = resource(() => loadWeek(login, week), () => `week/${login}/${week}`);

  /**
   * Until a day is picked by hand the view follows the lessons: it opens at today, after the last lesson at the
   * next school day, and when this week has none left (a Friday afternoon) on the next week.
   */
  let picked = $state(false);
  const pick = (d) => {
    picked = true;
    day = d;
  };
  const follow = () => {
    picked = false;
    day = t;
  };
  const focus = $derived(days.data ? upcomingDay(days.data) : undefined);
  $effect(() => {
    if (picked || focus === undefined) return;
    if (focus) day = focus.date;
    else if (week === thisMonday) day = shift(thisMonday, 7);
  });

  const dayOf = (d) => days.data?.find((x) => x.date === d);
  /** Saturday and Sunday count only when the school puts lessons on them. */
  const school = (d) => ![0, 6].includes(parse(d).getDay()) || Boolean(dayOf(d)?.lessons.length);
  const strip = $derived(Array.from({ length: 7 }, (_, i) => shift(week, i)).filter(school));

  function step(dir) {
    let d = shift(day, dir);
    while (!school(d)) d = shift(d, dir);
    pick(d);
  }
  const turn = (dir) => (view === 'day' ? step(dir) : pick(shift(day, 7 * dir)));

  // The days shown, not the calendar week: Monday to Friday unless the school teaches at the weekend.
  const range = $derived(new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long' }).formatRange(parse(week), parse(strip.at(-1))));
  const weekday = (d) => parse(d).toLocaleDateString('pl-PL', { weekday: 'short' });
  /**
   * The week side by side: one row per lesson slot, shared by every day, so lesson 3 lines up across the week. A number
   * taught twice in a day (split groups) takes as many slots as its busiest day needs.
   */
  function slots(list) {
    const most = new Map();
    for (const d of list) {
      const seen = new Map();
      for (const l of d.lessons) seen.set(l.LessonNo, (seen.get(l.LessonNo) ?? 0) + 1);
      for (const [no, n] of seen) most.set(no, Math.max(most.get(no) ?? 0, n));
    }
    const start = new Map();
    let rows = 0;
    for (const no of [...most.keys()].sort((a, b) => Number(a) - Number(b))) {
      start.set(no, rows + 1);
      rows += most.get(no);
    }
    const row = new Map();
    for (const d of list) {
      const seen = new Map();
      for (const l of d.lessons) {
        const k = seen.get(l.LessonNo) ?? 0;
        seen.set(l.LessonNo, k + 1);
        row.set(l, start.get(l.LessonNo) + k);
      }
    }
    return { rows, row };
  }

  const changed = (d) => Boolean(dayOf(d)?.lessons.some((l) => l.IsCanceled || l.change || l.note));
  /** A cancelled lesson is the change that matters most: its day's dot is red, like the "odwołana" mark. */
  const canceled = (d) => Boolean(dayOf(d)?.lessons.some((l) => l.IsCanceled));

  /** Runs when the card appears, not on refresh. A wide screen shows the week side by side: nothing to scroll to. */
  const reveal = (node, on) => {
    if (on && !picked && !matchMedia('(min-width: 900px)').matches) node.scrollIntoView({ block: 'start' });
  };
</script>

<div class="toolbar">
  <div class="segmented" role="group" aria-label="Widok planu">
    <button aria-pressed={view === 'day'} onclick={() => show('day')}>Dzień</button>
    <button aria-pressed={view === 'week'} onclick={() => show('week')}>Tydzień</button>
  </div>
</div>

<div class="pager">
  <button class="icon-btn" onclick={() => pick(shift(day, -7))} aria-label="Poprzedni tydzień" title="Poprzedni tydzień"><Icon name="left" /></button>
  <p class="range" aria-live={view === 'week' ? 'polite' : undefined}>{range}</p>
  <button class="icon-btn" onclick={() => pick(shift(day, 7))} aria-label="Następny tydzień" title="Następny tydzień"><Icon name="right" /></button>
  <button class="secondary now" onclick={follow} disabled={!picked}>Dziś</button>
</div>
{#if view === 'day'}
  <div class="days" role="group" aria-label="Dzień tygodnia">
    {#each strip as d (d)}
      <button
        aria-pressed={d === day}
        aria-current={d === t ? 'date' : undefined}
        aria-label={[fmtDay(d), canceled(d) ? 'odwołane lekcje' : changed(d) && 'zmiany w planie'].filter(Boolean).join(', ')}
        title={canceled(d) ? 'Odwołane lekcje' : changed(d) ? 'Zmiany w planie' : undefined}
        onclick={() => pick(d)}
      >
        <small>{weekday(d)}</small>
        <strong>{parse(d).getDate()}</strong>
        <span class="dot" class:on={changed(d)} class:alert={canceled(d)}></span>
      </button>
    {/each}
  </div>
  {#if strip.some(changed)}
    <p class="legend muted" aria-hidden="true">
      {#if strip.some(canceled)}<span><span class="dot on alert"></span>odwołane lekcje</span>{/if}
      {#if strip.some((d) => changed(d) && !canceled(d))}<span><span class="dot on"></span>zmiany w planie</span>{/if}
    </p>
  {/if}
{/if}

<div class="swipe" use:swipe={{ prev: () => turn(-1), next: () => turn(1) }}>
  {#if view === 'day'}
    <section class="card" class:today={day === t}>
      <h2 class="day" aria-live="polite">{fmtDay(day)}</h2>
      <Async r={days} empty="Brak planu na ten tydzień.">
        {#snippet children()}
          <Lessons lessons={dayOf(day)?.lessons ?? []} live={day === t} />
        {/snippet}
      </Async>
    </section>
  {:else}
    <Async r={days} empty="Brak planu na ten tydzień.">
      {#snippet children(list)}
        {@const shown = list.filter((d) => school(d.date))}
        {@const grid = slots(shown)}
        <div class="week" style:--rows={grid.rows + 1}>
          {#each shown as d (d.date)}
            {@const [weekday, date] = fmtDay(d.date).split(', ')}
            <section class="card" class:today={d.date === t} use:reveal={d.date === focus?.date}>
              <!-- The day strip's dot, here too; the lessons below say what changed, so it is not read out twice. -->
              <h2 class="day">{weekday}{#if changed(d.date)}<span class="dot on" class:alert={canceled(d.date)} aria-hidden="true"></span>{/if}<span
                  class="sep">{', '}</span
                ><span class="date">{date}</span></h2>
              <Lessons lessons={d.lessons} live={d.date === t} rowOf={(l) => grid.row.get(l)} />
            </section>
          {/each}
        </div>
      {/snippet}
    </Async>
  {/if}
</div>
