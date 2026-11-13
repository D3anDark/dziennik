<script module>
  import { clock } from './api.svelte.js';
  import { named } from './util.js';
  import { t } from './i18n.js';

  /**
   * The time of day, "HH:MM": read again on refresh, on coming back to the app (`clock`) and, while `on()`, as each
   * minute turns. Call while a component starts; its timer goes with the component.
   */
  export function wallClock(on) {
    let minute = $state(0);
    $effect(() => {
      if (!on()) return;
      let timer;
      const next = () => (timer = setTimeout(() => (minute++, next()), 60_000 - (Date.now() % 60_000)));
      next();
      return () => clearTimeout(timer);
    });
    return {
      get now() {
        return (clock.tick, minute, new Date().toTimeString().slice(0, 5));
      },
    };
  }

  export const teacher = (u) => (u ? named(u.FirstName, u.LastName) : '');

  /** A subject's hue, the same on every day: its id spread round the wheel by the golden angle, squeezed short of red (a cancellation's). */
  export function hue(s) {
    const n = Number(s?.Id);
    const k = Number.isFinite(n) ? n : [...String(s?.Name ?? '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 0);
    return Math.round(25 + (((k * 137.508) % 360) * 5) / 6);
  }

  /** A school's own category name ("zapowiedziane kartkówki") as the kind of test it is; any other, capitalised. */
  export const kind = (c) =>
    /kartk/i.test(c) ? t('Kartkówka') : /sprawdzian|klasówk|praca klasowa/i.test(c) ? t('Sprawdzian') : c.charAt(0).toUpperCase() + c.slice(1);

  const no = (l) => Number(l.LessonNo);
  /** By id; by name where Librus left either id out. */
  const same = (e, l) =>
    e.subjectId && l.Subject?.Id ? e.subjectId === String(l.Subject.Id) : e.subject.toLowerCase() === (l.Subject?.Name ?? '').toLowerCase();
  /**
   * Each test on the lesson it is for, as a Map. With a subject: one of that subject's lessons this day, the one at its
   * number or hour, else the nearest by number: a class split into groups gets one entry from a teacher, its lesson
   * number often wrong for some. No lesson of the subject this day: another group's test, left to the calendar. Without
   * a subject: the lesson at its number or hour, if any.
   */
  export function place(lessons, events) {
    const on = new Map();
    for (const e of events) {
      const fits = e.subjectId || e.subject ? lessons.filter((l) => same(e, l)) : lessons;
      const l =
        fits.find((l) => e.lesson && no(l) === e.lesson) ??
        fits.find((l) => e.from && l.HourFrom <= e.from && e.from < l.HourTo) ??
        (fits !== lessons && fits.length ? fits.reduce((a, b) => (Math.abs(no(b) - e.lesson) < Math.abs(no(a) - e.lesson) ? b : a)) : null);
      if (l) on.set(l, [...(on.get(l) ?? []), e]);
    }
    return on;
  }

  export const minutes = (hm) => Number(hm?.slice(0, 2)) * 60 + Number(hm?.slice(3, 5));
</script>

<script>
  import { room } from './util.js';

  /**
   * One day of timetable lessons as returned by `week()`. `live` is today's day: the lesson in progress or next is
   * marked, the one in progress counting down to its end. `events`: the day's tests and quizzes from `monthEvents()`,
   * each shown on its lesson (`place`).
   */
  let { lessons, live = false, events = [] } = $props();

  const time = wallClock(() => live);
  const now = $derived(time.now);
  const current = $derived(live ? lessons.findIndex((l) => !l.IsCanceled && l.HourTo > now) : -1);
  const placed = $derived(place(lessons, events));
  /**
   * Where the line of now goes: across lesson `i` at the share of it `gone` (a held one before a cancelled one of the
   * same hour), or, `gone` null, on the break before it. None outside the day's hours.
   */
  const line = $derived.by(() => {
    if (!live) return null;
    const running = (l) => l.HourFrom <= now && now < l.HourTo;
    let i = lessons.findIndex((l) => running(l) && !l.IsCanceled);
    if (i < 0) i = lessons.findIndex(running);
    if (i >= 0) {
      const from = minutes(lessons[i].HourFrom);
      return { i, gone: (minutes(now) - from) / (minutes(lessons[i].HourTo) - from) };
    }
    i = lessons.findIndex((l) => l.HourFrom > now);
    return i > 0 ? { i, gone: null } : null;
  });

  /** The break before lesson `i`, named: a free period where a lesson number is skipped. None for a group split at the same hour. */
  function pause(i) {
    const [prev, l] = [lessons[i - 1], lessons[i]];
    const m = minutes(l.HourFrom) - minutes(prev.HourTo);
    if (!(m > 0)) return null;
    if (Number(l.LessonNo) - Number(prev.LessonNo) > 1) return { text: t('Okienko {m} min', { m }), long: true };
    return m >= 15 ? { text: t('Długa przerwa {m} min', { m }), long: true } : { text: t('Przerwa {m} min', { m }), long: false };
  }
</script>

{#if !lessons.length}
  <p class="muted">{t('Brak lekcji.')}</p>
{:else}
  <ol class="lessons">
    {#each lessons as l, i (i)}
      <li class:canceled={l.IsCanceled} class:current={i === current}>
        {#if i}
          {@const p = pause(i)}
          <span class="break" class:long={p?.long} class:on={line?.i === i && line.gone === null}>{p?.text ?? ''}</span>
        {/if}
        <div class="lesson" style:--hue={hue(l.Subject)}>
          <span class="no">{l.LessonNo}</span>
          <span class="time">{l.HourFrom}<span class="dash">–</span><span class="muted">{l.HourTo}</span></span>
          <span class="subject">
            <!-- What a substitution replaced, struck out before what takes its place; read out as "X, teraz Y". -->
            <span class="name"
              >{#if l.was?.subject}<s class="was">{l.was.subject}</s><span class="sr">{t(', teraz')}</span>{' '}{/if}{l.Subject?.Name ?? ''}</span
            >
            <span class="marks"
              >{#if l.IsCanceled}<em class="tag">{t('odwołana')}</em>{:else if l.IsSubstitutionClass}<em class="tag notice">{t('zastępstwo')}</em>{/if}{#if i === current}<em
                  class="tag now">{l.HourFrom <= now ? t('do końca {m} min', { m: minutes(l.HourTo) - minutes(now) }) : t('następna')}</em
                >{/if}</span
            >
            <small class="muted">
              {#if l.was?.teacher}<s class="was">{l.was.teacher}</s><span class="sr">{t(', teraz')}</span>{' '}{/if}{[teacher(l.Teacher), l.room && room(l.room)]
                .filter(Boolean)
                .join(' · ')}
            </small>
            {#if l.change}<small class="change" title={l.change}>{l.change}</small>{/if}
            <!-- The teacher's own words, apart from the facts of the change above. -->
            {#if l.note}<small class="change note" title={l.note}>{l.note}</small>{/if}
            {#each placed.get(l) ?? [] as e (e.id)}
              <small class="test" title={e.detail || undefined}><em class="tag exam" title={e.category}>{kind(e.category)}</em>{#if e.detail}{e.detail}{/if}</small>
            {/each}
          </span>
        </div>
        <!-- After the block, so over it. The countdown beside the subject says the same in words. -->
        {#if line?.i === i && line.gone !== null}<span class="now" style:--gone={line.gone} aria-hidden="true"></span>{/if}
      </li>
    {/each}
  </ol>
{/if}
