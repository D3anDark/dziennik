<script>
  import { resource } from './api.svelte.js';
  import Icon from './Icon.svelte';
  import { today, mondayOf, shift, fmtDay, parse, room } from './util.js';
  import { week as loadWeek, upcomingDay, monthEvents } from './data.js';
  import { swipe } from './swipe.js';
  import Async from './Async.svelte';
  import Lessons, { wallClock, teacher, hue, kind, place, minutes } from './Lessons.svelte';

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
  /** The calendar's tests and quizzes in the months the week spans. A failure leaves the plan without them, said nowhere. */
  const exams = resource(async () => {
    const months = [...new Set([week, shift(week, 6)].map((d) => d.slice(0, 7)))];
    const all = await Promise.all(months.map((m) => monthEvents(login, Number(m.slice(0, 4)), Number(m.slice(5, 7)))));
    return all.flat().filter((e) => e.kind === 'event');
  }, () => `exams/${login}/${week}`);
  const examsOn = (d) => (exams.data ?? []).filter((e) => e.date === d);

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

  /** The week on a clock: whole hours from the earliest start to the latest end, a lesson as tall as it lasts. */
  function hours(list) {
    const all = list.flatMap((d) => d.lessons);
    const from = Math.floor(Math.min(...all.map((l) => minutes(l.HourFrom))) / 60);
    const to = Math.ceil(Math.max(...all.map((l) => minutes(l.HourTo))) / 60);
    return { from: from * 60, to: to * 60, marks: Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(2, '0')}:00`) };
  }
  /** Lessons at the same time (groups, a cancelled lesson and its replacement) side by side: each its column of the overlap. */
  function columns(lessons) {
    const out = new Map();
    let group = [];
    let ends = [];
    let end = -1;
    const close = () => group.forEach(([l, col]) => out.set(l, { col, cols: ends.length }));
    for (const l of [...lessons].sort((a, b) => minutes(a.HourFrom) - minutes(b.HourFrom))) {
      const [from, to] = [minutes(l.HourFrom), minutes(l.HourTo)];
      if (from >= end) {
        close();
        [group, ends] = [[], []];
      }
      let col = ends.findIndex((e) => e <= from);
      if (col < 0) col = ends.push(to) - 1;
      ends[col] = to;
      group.push([l, col]);
      end = Math.max(end, to);
    }
    close();
    return out;
  }
  /** What a lesson's block says out loud; the day view has it all in full. */
  const said = (l, tests) =>
    [
      `${l.HourFrom}–${l.HourTo}`,
      l.Subject?.Name,
      teacher(l.Teacher),
      l.room && room(l.room),
      l.IsCanceled && 'odwołana',
      l.IsSubstitutionClass && 'zastępstwo',
      l.was && `zamiast: ${[l.was.subject, l.was.teacher].filter(Boolean).join(', ')}`,
      ...tests.map((e) => [kind(e.category), e.detail].filter(Boolean).join(': ')),
    ]
      .filter(Boolean)
      .join(', ');
  /** A lesson or a day tapped in the week opens that day, in full; the remembered view stays the week. */
  const open = (d) => {
    pick(d);
    view = 'day';
  };
  const time = wallClock(() => view === 'week');

  const changed = (d) => Boolean(dayOf(d)?.lessons.some((l) => l.IsCanceled || l.was || l.change || l.note));
  /** A cancelled lesson is the change that matters most: its day's dot is red, like the "odwołana" mark. */
  const canceled = (d) => Boolean(dayOf(d)?.lessons.some((l) => l.IsCanceled));

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
          <Lessons lessons={dayOf(day)?.lessons ?? []} live={day === t} events={examsOn(day)} />
        {/snippet}
      </Async>
    </section>
  {:else}
    <Async r={days} empty="Brak planu na ten tydzień.">
      {#snippet children(list)}
        {@const shown = list.filter((d) => school(d.date))}
        {#if !shown.some((d) => d.lessons.length)}
          <p class="muted">Brak lekcji w tym tygodniu.</p>
        {:else}
          {@const span = hours(shown)}
          {@const now = minutes(time.now)}
          <div class="week" style:--from={span.from} style:--span={span.to - span.from} style:--days={shown.length}>
            <span></span>
            {#each shown as d (d.date)}
              <button
                class="wday"
                aria-current={d.date === t ? 'date' : undefined}
                aria-label={[fmtDay(d.date), canceled(d.date) ? 'odwołane lekcje' : changed(d.date) && 'zmiany w planie'].filter(Boolean).join(', ')}
                onclick={() => open(d.date)}
              >
                <small>{weekday(d.date)}</small>
                <strong>{parse(d.date).getDate()}</strong>
                <span class="dot" class:on={changed(d.date)} class:alert={canceled(d.date)}></span>
              </button>
            {/each}
            <ol class="hours" aria-hidden="true">
              {#each span.marks as h (h)}<li style:--at={minutes(h)}>{h}</li>{/each}
            </ol>
            {#each shown as d (d.date)}
              {@const cols = columns(d.lessons)}
              {@const tests = place(d.lessons, examsOn(d.date))}
              {@const live = d.date === t}
              <ol class="column" aria-label={fmtDay(d.date)}>
                {#if live && now >= span.from && now < span.to}<li class="now" style:--at={now} aria-hidden="true"></li>{/if}
                {#each d.lessons as l, i (i)}
                  {@const at = cols.get(l)}
                  {@const own = tests.get(l) ?? []}
                  {@const running = live && !l.IsCanceled && minutes(l.HourFrom) <= now && now < minutes(l.HourTo)}
                  <li
                    class:canceled={l.IsCanceled}
                    class:current={running}
                    style:--start={minutes(l.HourFrom)}
                    style:--end={minutes(l.HourTo)}
                    style:--col={at.col}
                    style:--cols={at.cols}
                    style:--hue={hue(l.Subject)}
                  >
                    <button aria-label={said(l, own)} title={said(l, own)} onclick={() => open(d.date)}>
                      <span class="time">{running ? `do końca ${minutes(l.HourTo) - now} min` : `${l.HourFrom}–${l.HourTo}`}</span>
                      <!-- "j. polski", as in the school's own plan: two lines of a narrow column hold it whole. -->
                      <strong class="name">{(l.Subject?.Name ?? '').replace(/^język /i, 'j. ')}</strong>
                      {#each own as e (e.id)}<em class="tag exam">{kind(e.category)}</em>{/each}
                      <!-- A substitution's ring, then the room: a narrow block cuts the end of the line. -->
                      <small
                        >{#if l.IsSubstitutionClass || l.was}<span class="dot on"></span>{/if}{l.room ? room(l.room) : ''}{#if l.Teacher}<span
                            class="who">{l.room ? ' · ' : ''}{teacher(l.Teacher)}</span
                          >{/if}</small
                      >
                    </button>
                  </li>
                {/each}
              </ol>
            {/each}
          </div>
        {/if}
      {/snippet}
    </Async>
  {/if}
</div>
