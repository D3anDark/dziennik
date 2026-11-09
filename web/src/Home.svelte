<script>
  import { synergia, lookup, resource, byId, inbox } from './api.svelte.js';
  import { today, mondayOf, shift, fmtDay, fmtDate, gradeTone } from './util.js';
  import Icon from './Icon.svelte';
  import { week, monthEvents } from './data.js';
  import Async from './Async.svelte';
  import Lessons from './Lessons.svelte';
  import Events from './Events.svelte';

  let { login } = $props();
  const t = today();
  const AHEAD = 14;

  /** The first day from today on that has lessons, looking into next week when this one is over. */
  async function nextDay(login) {
    for (const start of [mondayOf(t), shift(mondayOf(t), 7)]) {
      const day = (await week(login, start)).find((d) => d.date >= t && d.lessons.length);
      if (day) return day;
    }
    return null;
  }

  async function recentGrades(login) {
    const [g, s] = await Promise.all([synergia(login, 'Grades'), lookup(login, 'Subjects')]);
    const names = byId(s.Subjects);
    return [...(g.Grades ?? [])]
      .sort((a, b) => (b.AddDate ?? '').localeCompare(a.AddDate ?? ''))
      .slice(0, 8)
      .map((x) => ({ id: x.Id, value: x.Grade, subject: names.get(String(x.Subject?.Id))?.Name ?? 'Inne', date: x.Date }));
  }

  async function upcoming(login) {
    const end = shift(t, AHEAD);
    const [y, m] = [Number(t.slice(0, 4)), Number(t.slice(5, 7))];
    const next = new Date(y, m, 1);
    const months = [[y, m]];
    if (end.slice(0, 7) !== t.slice(0, 7)) months.push([next.getFullYear(), next.getMonth() + 1]);
    const all = (await Promise.all(months.map(([yy, mm]) => monthEvents(login, yy, mm)))).flat();
    return all.filter((e) => (e.to || e.date) >= t && e.date <= end);
  }

  const day = resource(() => nextDay(login));
  const grades = resource(() => recentGrades(login));
  const events = resource(() => upcoming(login));
</script>

{#if inbox.unread}
  <a class="card callout" href="#/wiadomosci">
    <span class="tile"><Icon name="mail" /></span>
    <span class="grow">Nieprzeczytane wiadomości: {inbox.unread}</span>
    <Icon name="right" size={18} />
  </a>
{/if}

<Async r={day}>
  {#snippet children(d)}
    {#if d}
      <section class="card" class:today={d.date === t}>
        <h2>{d.date === t ? 'Dziś' : fmtDay(d.date)}</h2>
        <Lessons lessons={d.lessons} />
      </section>
    {:else}
      <p class="center muted">Brak lekcji w najbliższych dniach.</p>
    {/if}
  {/snippet}
</Async>

<h2 class="section">Ostatnie oceny</h2>
<Async r={grades} empty="Brak ocen.">
  {#snippet children(list)}
    <ul class="card entries">
      {#each list as g (g.id)}
        <li>
          <span class="chip static {gradeTone(g.value)}">{g.value}</span>
          <span>{g.subject}</span>
          <span class="muted">{fmtDate(g.date)}</span>
        </li>
      {/each}
    </ul>
  {/snippet}
</Async>

<h2 class="section">Najbliższe {AHEAD} dni</h2>
<Async r={events} empty="Nic zaplanowanego.">
  {#snippet children(list)}
    <Events events={list} today={t} />
  {/snippet}
</Async>
