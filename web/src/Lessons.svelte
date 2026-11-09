<script>
  /** One day of timetable lessons as returned by `week()`. */
  let { lessons } = $props();

  const teacher = (t) => (t ? `${t.FirstName ?? ''} ${t.LastName ?? ''}`.trim() : '');
</script>

{#if !lessons.length}
  <p class="muted">Brak lekcji.</p>
{:else}
  <ol class="lessons">
    {#each lessons as l, i (i)}
      <li class:canceled={l.IsCanceled}>
        <span class="no">{l.LessonNo}</span>
        <span class="time muted">{l.HourFrom}–{l.HourTo}</span>
        <span class="subject">
          {l.Subject?.Name ?? ''}
          {#if l.IsCanceled}<em class="tag">odwołana</em>{:else if l.IsSubstitutionClass}<em class="tag">zastępstwo</em>{/if}
          <small class="muted">
            {[teacher(l.Teacher), l.room && `sala ${l.room}`].filter(Boolean).join(', ')}
          </small>
        </span>
      </li>
    {/each}
  </ol>
{/if}
