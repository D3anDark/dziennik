<script>
  import { resource } from './api.svelte.js';
  import Icon from './Icon.svelte';
  import { today } from './util.js';
  import { monthEvents } from './data.js';
  import { swipe } from './swipe.js';
  import Async from './Async.svelte';
  import Events from './Events.svelte';

  let { login } = $props();

  const t = today();
  const now = { y: Number(t.slice(0, 4)), m: Number(t.slice(5, 7)) };
  let month = $state(now);
  const label = $derived(new Date(month.y, month.m - 1, 1).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' }));

  function move(delta) {
    const d = new Date(month.y, month.m - 1 + delta, 1);
    month = { y: d.getFullYear(), m: d.getMonth() + 1 };
  }

  const events = resource(() => monthEvents(login, month.y, month.m), () => `calendar/${login}/${month.y}-${month.m}`);
</script>

<div class="pager">
  <button class="icon-btn" onclick={() => move(-1)} aria-label="Poprzedni miesiąc" title="Poprzedni miesiąc"><Icon name="left" /></button>
  <h2 class="range" aria-live="polite">{label}</h2>
  <button class="icon-btn" onclick={() => move(1)} aria-label="Następny miesiąc" title="Następny miesiąc"><Icon name="right" /></button>
  <button class="secondary now" onclick={() => (month = now)} disabled={month.y === now.y && month.m === now.m}>Dziś</button>
</div>

<div class="swipe" use:swipe={{ prev: () => move(-1), next: () => move(1) }}>
  <Async r={events} empty="Brak wpisów w tym miesiącu.">
    {#snippet children(list)}
      <Events events={list} today={t} />
    {/snippet}
  </Async>
</div>
