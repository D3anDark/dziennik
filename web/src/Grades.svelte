<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDate, person, plain, gradeTone } from './util.js';
  import Async from './Async.svelte';

  let { login } = $props();
  let open = $state(null);

  function kind(c) {
    if (c?.IsFinal) return 'Ocena roczna';
    if (c?.IsFinalProposition) return 'Proponowana roczna';
    if (c?.IsSemestral) return 'Ocena semestralna';
    if (c?.IsSemestralProposition) return 'Proponowana semestralna';
    return null;
  }

  /** Librus sends "0.00" (or nothing) when a school hides averages. */
  const avg = (v) => (Number(v) > 0 ? Number(v).toFixed(2) : null);

  async function load(login) {
    const soft = () => ({});
    const [g, s, c, u, a, cm] = await Promise.all([
      synergia(login, 'Grades'),
      lookup(login, 'Subjects'),
      lookup(login, 'Grades/Categories'),
      lookup(login, 'Users'),
      synergia(login, 'Grades/Averages').catch(soft),
      synergia(login, 'Grades/Comments').catch(soft),
    ]);
    const [cats, names, users, comments] = [byId(c.Categories), byId(s.Subjects), byId(u.Users), byId(cm.Comments)];
    const averages = new Map((a.Averages ?? []).map((x) => [String(x.Subject?.Id), x]));
    const groups = new Map();
    for (const gr of g.Grades ?? []) {
      const key = String(gr.Subject?.Id);
      if (!groups.has(key)) {
        const av = averages.get(key);
        groups.set(key, {
          key,
          name: names.get(key)?.Name ?? 'Inne',
          avg: [
            ['I sem.', avg(av?.Semester1)],
            ['II sem.', avg(av?.Semester2)],
            ['rok', avg(av?.FullYear)],
          ].filter(([, v]) => v),
          s1: [],
          s2: [],
          final: [],
        });
      }
      const group = groups.get(key);
      const cat = cats.get(String(gr.Category?.Id));
      const item = {
        id: gr.Id,
        value: gr.Grade,
        date: gr.Date,
        category: cat?.Name ?? '',
        weight: cat?.CountToTheAverage ? cat.Weight : null,
        teacher: gr.AddedBy?.Id ? person(users.get(String(gr.AddedBy.Id))) : '',
        comment: (gr.Comments ?? []).map((x) => plain(comments.get(String(x.Id))?.Text)).filter(Boolean).join(' '),
        kind: kind(cat),
      };
      (item.kind ? group.final : Number(gr.Semester) === 2 ? group.s2 : group.s1).push(item);
    }
    return [...groups.values()].sort((p, q) => p.name.localeCompare(q.name, 'pl'));
  }

  const subjects = resource(() => load(login));
</script>

<Async r={subjects} empty="Brak ocen.">
  {#snippet children(list)}
    {#each list as s (s.key)}
      <section class="card">
        <h2>{s.name}</h2>
        {#each [['I sem.', s.s1], ['II sem.', s.s2]] as [label, grades] (label)}
          {#if grades.length}
            <div class="row">
              <span class="muted label">{label}</span>
              <ul class="chips">
                {#each grades as g (g.id)}
                  <li>
                    <button class="chip {gradeTone(g.value)}" aria-expanded={open === g.id} onclick={() => (open = open === g.id ? null : g.id)}>
                      {g.value}
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
            {#each grades.filter((g) => g.id === open) as g (g.id)}
              <p class="detail">
                {g.category || 'Bez kategorii'}, {fmtDate(g.date)}{#if g.weight}, waga {g.weight}{/if}{#if g.teacher}, {g.teacher}{/if}
                {#if g.comment}<br />{g.comment}{/if}
              </p>
            {/each}
          {/if}
        {/each}
        {#each s.final as g (g.id)}
          <p class="final">{g.kind}: <strong class="chip static {gradeTone(g.value)}">{g.value}</strong></p>
        {/each}
        {#if s.avg.length}
          <p class="final muted">Średnia: {s.avg.map(([k, v]) => `${k} ${v}`).join(', ')}</p>
        {/if}
      </section>
    {/each}
  {/snippet}
</Async>
