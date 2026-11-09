<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDate, person, plain } from './util.js';
  import Async from './Async.svelte';
  import Rich from './Rich.svelte';

  let { login } = $props();

  // Notes.Positive: 0 negative, 1 positive, 2 neutral.
  const TYPES = ['negatywna', 'pozytywna', 'neutralna'];

  async function load(login) {
    const [n, c, u] = await Promise.all([
      synergia(login, 'Notes'),
      lookup(login, 'Notes/Categories'),
      lookup(login, 'Users'),
    ]);
    const [cats, users] = [byId(c.Categories), byId(u.Users)];
    return (n.Notes ?? [])
      .map((x) => {
        const cat = cats.get(String(x.Category?.Id));
        return {
          id: x.Id,
          text: plain(x.Text),
          date: x.Date ?? '',
          type: TYPES[Number(x.Positive)] ?? '',
          category: cat?.Name ?? cat?.CategoryName ?? '',
          who: x.Teacher?.Id ? person(users.get(String(x.Teacher.Id))) : '',
        };
      })
      .sort((p, q) => q.date.localeCompare(p.date));
  }

  const list = resource(() => load(login));
</script>

<Async r={list} empty="Brak uwag.">
  {#snippet children(items)}
    {#each items as n (n.id)}
      <article class="card note {n.type}">
        <h2>{[n.category, n.type].filter(Boolean).join(', ') || 'Uwaga'}</h2>
        <p class="muted">{[fmtDate(n.date), n.who].filter(Boolean).join(', ')}</p>
        <Rich text={n.text} />
      </article>
    {/each}
  {/snippet}
</Async>
