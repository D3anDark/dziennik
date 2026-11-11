<script>
  import { clock } from './api.svelte.js';
  import { room } from './util.js';

  /**
   * One day of timetable lessons as returned by `week()`. `live` is today's day: the lesson in progress or next is
   * marked. `rowOf`, in the week grid, gives each lesson its row there (`--row`).
   */
  let { lessons, live = false, rowOf } = $props();

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
      <li class:canceled={l.IsCanceled} class:current={i === current} style:--row={rowOf?.(l)}>
        <span class="no">{l.LessonNo}</span>
        <span class="time muted">{l.HourFrom}<span class="dash">–</span>{l.HourTo}</span>
        <span class="subject">
          <span class="name">{l.Subject?.Name ?? ''}</span>
          <span class="marks"
            >{#if l.IsCanceled}<em class="tag">odwołana</em>{:else if l.IsSubstitutionClass}<em class="tag notice">zastępstwo</em>{/if}{#if i === current}<em
                class="tag now">{l.HourFrom <= now ? 'teraz' : 'następna'}</em
              >{/if}</span
          >
          <small class="muted">
            {[teacher(l.Teacher), l.room && room(l.room)].filter(Boolean).join(' · ')}
          </small>
          {#if l.change}<small class="change">{l.change}</small>{/if}
          <!-- The teacher's own words, apart from the facts of the change above. -->
          {#if l.note}<small class="change note">{l.note}</small>{/if}
        </span>
      </li>
    {/each}
  </ol>
{/if}
