<script>
  import { clock } from './api.svelte.js';

  /** One day of timetable lessons as returned by `week()`. `live` is today's day: the lesson in progress or next is marked. */
  let { lessons, live = false } = $props();

  // Recomputed on refresh and on coming back to the app (`clock`), not by a timer.
  const now = $derived((clock.tick, new Date().toTimeString().slice(0, 5)));
  const current = $derived(live ? lessons.findIndex((l) => !l.IsCanceled && l.HourTo > now) : -1);

  const teacher = (t) => (t ? `${t.FirstName ?? ''} ${t.LastName ?? ''}`.trim() : '');
</script>

{#if !lessons.length}
  <p class="muted">Brak lekcji.</p>
{:else}
  <ol class="lessons">
    {#each lessons as l, i (i)}
      <li class:canceled={l.IsCanceled} class:current={i === current}>
        <span class="no">{l.LessonNo}</span>
        <span class="time muted">{l.HourFrom}–{l.HourTo}</span>
        <span class="subject">
          {l.Subject?.Name ?? ''}
          {#if l.IsCanceled}<em class="tag">odwołana</em>{:else if l.IsSubstitutionClass}<em class="tag">zastępstwo</em>{/if}
          {#if i === current}<em class="tag now">{l.HourFrom <= now ? 'teraz' : 'następna'}</em>{/if}
          <small class="muted">
            {[teacher(l.Teacher), l.room && `sala ${l.room}`].filter(Boolean).join(', ')}
          </small>
          {#if l.change}<small class="change">{l.change}</small>{/if}
        </span>
      </li>
    {/each}
  </ol>
{/if}
