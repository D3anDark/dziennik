<script>
  import { fmtDay, fmtDate } from './util.js';
  import Rich from './Rich.svelte';

  /** Calendar entries from `monthEvents()`, grouped under their start day. `flat` drops the card of each day, for use inside a panel. */
  let { events, today, flat = false } = $props();

  // Map.groupBy needs iOS 17.4+; a loop keeps older phones working.
  const days = $derived.by(() => {
    const m = new Map();
    for (const e of events) {
      if (!m.has(e.date)) m.set(e.date, []);
      m.get(e.date).push(e);
    }
    return m;
  });
</script>

{#each days as [date, list] (date)}
  <section class:card={!flat} class:day-group={flat} class:today={!flat && date === today}>
    <svelte:element this={flat ? 'h3' : 'h2'} class={flat ? 'section' : 'day'}>{fmtDay(date)}</svelte:element>
    <ul class="events">
      {#each list as e (e.id)}
        <li class={e.kind}>
          <strong>{e.title}</strong>
          <small class="muted">
            {[e.to && `do ${fmtDate(e.to)}`, e.when, e.who].filter(Boolean).join(' · ')}
          </small>
          {#if e.detail}<Rich text={e.detail} />{/if}
        </li>
      {/each}
    </ul>
  </section>
{/each}
