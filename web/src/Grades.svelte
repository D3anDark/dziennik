<script>
  import { resource } from './api.svelte.js';
  import { fmtDate } from './util.js';
  import { grades } from './data.js';
  import Async from './Async.svelte';

  let { login } = $props();
  let open = $state(null);

  /** Librus sends "0.00" (or nothing) when a school hides averages. */
  const avg = (v) => (Number(v) > 0 ? Number(v).toFixed(2) : null);

  async function load(login) {
    const { items, averages } = await grades(login);
    const groups = new Map();
    for (const g of items) {
      if (!groups.has(g.subject)) {
        const av = averages.get(g.subject);
        groups.set(g.subject, {
          key: g.subject,
          name: g.name,
          avg: [
            ['I sem.', avg(av?.Semester1)],
            ['II sem.', avg(av?.Semester2)],
            ['rok', avg(av?.FullYear)],
          ].filter(([, v]) => v),
          // by `semester`: 0 holds descriptive grades that belong to no semester
          rows: [[], [], []],
          final: [],
        });
      }
      const group = groups.get(g.subject);
      (g.kind ? group.final : group.rows[g.semester]).push(g);
    }
    return [...groups.values()].sort((p, q) => p.name.localeCompare(q.name, 'pl'));
  }

  const subjects = resource(() => load(login));
</script>

<Async r={subjects} empty="Brak ocen.">
  {#snippet children(list)}
    <div class="card sheet">
      {#each list as s (s.key)}
        <section>
          <div class="head">
            <h2>{s.name}</h2>
            {#if s.avg.length}<span>śr. {s.avg.map(([k, v]) => `${k} ${v}`).join(', ')}</span>{/if}
          </div>
          {#each [['I sem.', s.rows[1]], ['II sem.', s.rows[2]], ['Opis', s.rows[0]]] as [label, grades] (label)}
            {#if grades.length}
              <div class="row">
                <span class="muted label">{label}</span>
                <ul class="chips">
                  {#each grades as g (g.id)}
                    <li>
                      <button class="chip {g.tone}" aria-label="Ocena {g.value}" aria-expanded={open === g.id} onclick={() => (open = open === g.id ? null : g.id)}>
                        {g.value}
                      </button>
                    </li>
                  {/each}
                </ul>
              </div>
              {#each grades.filter((g) => g.id === open) as g (g.id)}
                <p class="detail">
                  {g.category || 'Bez kategorii'}, {fmtDate(g.date)}{#if g.weight}, waga {g.weight}{/if}{#if g.teacher}, {g.teacher}{/if}
                  {#if g.text}<br />{g.text}{/if}
                  {#if g.comment}<br />{g.comment}{/if}
                </p>
              {/each}
            {/if}
          {/each}
          {#each s.final as g (g.id)}
            <p class="final">{g.kind}: <strong class="chip static {g.tone}">{g.value}</strong></p>
          {/each}
        </section>
      {/each}
    </div>
  {/snippet}
</Async>
