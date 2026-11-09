<script>
  import { resource } from './api.svelte.js';
  import Icon from './Icon.svelte';
  import { today, mondayOf, shift, fmtDay } from './util.js';
  import { week as loadWeek } from './data.js';
  import Async from './Async.svelte';
  import Lessons from './Lessons.svelte';

  let { login } = $props();

  const t = today();
  const thisMonday = mondayOf(t);
  let week = $state(thisMonday);
  const days = resource(() => loadWeek(login, week));
</script>

<div class="weeknav">
  <button onclick={() => (week = shift(week, -7))}><Icon name="left" size={18} />Poprzedni</button>
  <button onclick={() => (week = thisMonday)} disabled={week === thisMonday}>Ten tydzień</button>
  <button onclick={() => (week = shift(week, 7))}>Następny<Icon name="right" size={18} /></button>
</div>

<Async r={days} empty="Brak planu na ten tydzień.">
  {#snippet children(list)}
    {#each list as d (d.date)}
      <section class="card" class:today={d.date === t}>
        <h2>{fmtDay(d.date)}</h2>
        <Lessons lessons={d.lessons} />
      </section>
    {/each}
  {/snippet}
</Async>
