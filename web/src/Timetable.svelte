<script>
  import { resource } from './api.svelte.js';
  import Icon from './Icon.svelte';
  import { today, mondayOf, shift, fmtDay } from './util.js';
  import { week as loadWeek, upcomingDay } from './data.js';
  import { swipe } from './swipe.js';
  import Async from './Async.svelte';
  import Lessons from './Lessons.svelte';

  let { login } = $props();

  const t = today();
  const thisMonday = mondayOf(t);
  let week = $state(thisMonday);
  const days = resource(() => loadWeek(login, week));

  /**
   * Until a week is picked by hand the view follows the lessons: it opens at today, after the last lesson at the
   * next school day, and when this week has none left (a Friday afternoon) on the next week.
   */
  let picked = false;
  const pick = (to) => {
    picked = true;
    week = to;
  };
  const focus = $derived(days.data ? upcomingDay(days.data) : undefined);
  $effect(() => {
    if (!picked && week === thisMonday && focus === null) week = shift(thisMonday, 7);
  });
  /** Runs when the card appears, not on refresh. */
  const reveal = (node, on) => {
    if (on && !picked) node.scrollIntoView({ block: 'start' });
  };
</script>

<div class="weeknav">
  <button onclick={() => pick(shift(week, -7))}><Icon name="left" size={18} />Poprzedni</button>
  <button onclick={() => pick(thisMonday)} disabled={week === thisMonday}>Ten tydzień</button>
  <button onclick={() => pick(shift(week, 7))}>Następny<Icon name="right" size={18} /></button>
</div>

<div class="swipe" use:swipe={{ prev: () => pick(shift(week, -7)), next: () => pick(shift(week, 7)) }}>
<Async r={days} empty="Brak planu na ten tydzień.">
  {#snippet children(list)}
    {#each list as d (d.date)}
      <section class="card" class:today={d.date === t} use:reveal={d.date === focus?.date}>
        <h2>{fmtDay(d.date)}</h2>
        <Lessons lessons={d.lessons} live={d.date === t} />
      </section>
    {/each}
  {/snippet}
</Async>
</div>
