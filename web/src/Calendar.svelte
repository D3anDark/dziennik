<script>
  import { resource } from './api.svelte.js';
  import Icon from './Icon.svelte';
  import { today, parse, shift, fmtDay, fmtDate, plural } from './util.js';
  import { monthEvents } from './data.js';
  import { swipe } from './swipe.js';
  import Async from './Async.svelte';
  import Events from './Events.svelte';

  let { login } = $props();

  const t = today();
  const now = { y: Number(t.slice(0, 4)), m: Number(t.slice(5, 7)) };
  const WEEKDAYS = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
  /** Entries named inside a day's cell; the rest of them counted. */
  const IN_CELL = 2;
  /** Days in the list until asked for more. */
  const IN_LIST = 3;

  let month = $state(now);
  /** The day whose entries the list shows; none: the whole month. */
  let picked = $state(null);
  /** The list in full, once asked; short again on another month or day. */
  let all = $derived.by(() => {
    month;
    picked;
    return false;
  });
  const label = $derived(new Date(month.y, month.m - 1, 1).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' }));

  function move(delta) {
    const d = new Date(month.y, month.m - 1 + delta, 1);
    month = { y: d.getFullYear(), m: d.getMonth() + 1 };
    picked = null;
  }

  const events = resource(() => monthEvents(login, month.y, month.m), () => `calendar/${login}/${month.y}-${month.m}`);

  /** The three entries coming next from today, whichever month is on screen: this month's and the next one's. */
  async function soonest() {
    const next = new Date(now.y, now.m, 1);
    const both = await Promise.all([monthEvents(login, now.y, now.m), monthEvents(login, next.getFullYear(), next.getMonth() + 1)]);
    // An entry spanning both months comes in both answers.
    const all = [...new Map(both.flat().map((e) => [e.id, e])).values()];
    return all.filter((e) => (e.to || e.date) >= t).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).slice(0, 3);
  }
  const soon = resource(soonest, () => `soon/${login}/${t}`);

  const covers = (e, d) => e.date <= d && d <= (e.to || e.date);
  const days = $derived.by(() => {
    const first = `${month.y}-${String(month.m).padStart(2, '0')}-01`;
    const count = new Date(month.y, month.m, 0).getDate();
    return Array.from({ length: count }, (_, i) => shift(first, i));
  });
  // Monday first: how many cells stay empty before the 1st.
  const lead = $derived((parse(days[0]).getDay() + 6) % 7);
  // And how many after the last day, to fill the last week.
  const trail = $derived((7 - ((lead + days.length) % 7)) % 7);
  /** Entries per day of the month on screen; one spanning days counts on each of them. */
  const byDay = $derived(new Map(days.map((d) => [d, (events.data ?? []).filter((e) => covers(e, d))])));

  const entries = (n) => `${n} ${plural(n, ['wpis', 'wpisy', 'wpisów'])}`;
  const dayLabel = (d, list) => [fmtDay(d), list.length && `${entries(list.length)}: ${list.map((e) => e.title).join('; ')}`].filter(Boolean).join(', ');

  /** "Dziś", "Jutro", "pt 14 lis"; an entry under way since before today, by its end. */
  function when(e) {
    if (e.date < t) return `do ${fmtDate(e.to)}`;
    if (e.date === t) return 'Dziś';
    if (e.date === shift(t, 1)) return 'Jutro';
    return `${parse(e.date).toLocaleDateString('pl-PL', { weekday: 'short' }).replace('.', '')} ${fmtDate(e.date)}`;
  }

  let below = $state();
  // On a phone the picked day's entries are under the month, out of sight: scrolled up just enough to be seen.
  $effect(() => {
    if (picked) below?.scrollIntoView({ block: 'nearest' });
  });

  /** A tile opens its day in the calendar, or today for an entry already under way. */
  function show(e) {
    const d = e.date < t ? t : e.date;
    month = { y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) };
    picked = d;
  }
</script>

<div class="panels cal">
  <div class="col">
    <section class="soon" aria-labelledby="soon-title">
      <h2 id="soon-title" class="section">Najbliższe</h2>
      <Async r={soon} empty="Nic zaplanowanego.">
        {#snippet children(list)}
          <ul>
            {#each list as e (e.id)}
              <li>
                <button onclick={() => show(e)} aria-label="{fmtDay(e.date < t ? t : e.date)}: {e.title}">
                  <small><span class="mark {e.kind}"></span>{when(e)}</small>
                  <strong>{e.title}</strong>
                </button>
              </li>
            {/each}
          </ul>
        {/snippet}
      </Async>
    </section>

    <div class="pager">
      <button class="icon-btn" onclick={() => move(-1)} aria-label="Poprzedni miesiąc" title="Poprzedni miesiąc"><Icon name="left" /></button>
      <h2 class="range" aria-live="polite">{label}</h2>
      <button class="icon-btn" onclick={() => move(1)} aria-label="Następny miesiąc" title="Następny miesiąc"><Icon name="right" /></button>
      <button class="secondary now" onclick={() => ((month = now), (picked = null))} disabled={month.y === now.y && month.m === now.m && !picked}>Dziś</button>
    </div>

    <section class="card month" use:swipe={{ prev: () => move(-1), next: () => move(1) }}>
      <div class="weekdays" aria-hidden="true">
        {#each WEEKDAYS as w (w)}<span>{w}</span>{/each}
      </div>
      <div class="grid" role="group" aria-label="Dni miesiąca">
        {#each { length: lead }}<span></span>{/each}
        {#each days as d (d)}
          {@const list = byDay.get(d)}
          <button
            class:free={list.some((e) => e.kind === 'free')}
            class:weekend={parse(d).getDay() % 6 === 0}
            aria-pressed={d === picked}
            aria-current={d === t ? 'date' : undefined}
            aria-label={dayLabel(d, list)}
            title={list.map((e) => e.title).join('\n') || undefined}
            onclick={() => (picked = d === picked ? null : d)}
          >
            <span class="num">{parse(d).getDate()}</span>
            {#each list.slice(0, IN_CELL) as e (e.id)}<span class="ev {e.kind}">{e.title}</span>{/each}
            {#if list.length > IN_CELL}<span class="more">+{list.length - IN_CELL}</span>{/if}
          </button>
        {/each}
        {#each { length: trail }}<span></span>{/each}
      </div>
    </section>
  </div>

  <div class="col">
    {#if picked}
      <p><button class="link" onclick={() => (picked = null)}><Icon name="left" size={18} />Cały miesiąc</button></p>
    {/if}
    <div class="swipe" bind:this={below} use:swipe={{ prev: () => move(-1), next: () => move(1) }}>
      <Async r={events} empty="Brak wpisów w tym miesiącu.">
        {#snippet children(list)}
          {@const shown = picked ? list.filter((e) => covers(e, picked)) : list}
          {#if shown.length}
            {@const firsts = new Set([...new Set(shown.map((e) => e.date))].slice(0, IN_LIST))}
            {@const cut = all ? shown : shown.filter((e) => firsts.has(e.date))}
            <Events events={cut} today={t} />
            {#if cut.length < shown.length}
              <button class="secondary wide" onclick={() => (all = true)}>Pokaż więcej</button>
            {/if}
          {:else}
            <p class="center muted">Tego dnia nic nie ma.</p>
          {/if}
        {/snippet}
      </Async>
    </div>
  </div>
</div>
