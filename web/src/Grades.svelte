<script>
  import { resource } from './api.svelte.js';
  import { fmtDate, fmtAverage } from './util.js';
  import { grades, unseenGrades, markGradeSeen } from './data.js';
  import Async from './Async.svelte';
  import Mark from './Mark.svelte';

  let { login } = $props();
  let open = $state(null);

  /** Librus sends "0.00" (or nothing) when a school hides averages. */
  const avg = (v) => (Number(v) > 0 ? fmtAverage(Number(v)) : null);

  async function load(login) {
    const { items, averages } = await grades(login);
    const groups = new Map();
    const fresh = unseenGrades(login, items);
    for (const g of items) {
      if (!groups.has(g.subject)) {
        const av = averages.get(g.subject);
        groups.set(g.subject, {
          key: g.subject,
          name: g.name,
          // Subjects missing from Librus' list are all "Inne"; whoever gave the grades tells them apart.
          hint: g.subject !== 'whole' && g.name === 'Inne' ? g.teacher : '',
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
      g.fresh = fresh.has(g.id);
      (g.kind ? group.final : group.rows[g.semester]).push(g);
    }
    // Named subjects first; "Inne" (subjects Librus does not list) and the descriptive grades of the whole year after them.
    const rank = (s) => (s.key === 'whole' ? 2 : s.name === 'Inne' ? 1 : 0);
    return [...groups.values()].sort((p, q) => rank(p) - rank(q) || p.name.localeCompare(q.name, 'pl'));
  }

  const subjects = resource(() => load(login), () => `grades/${login}`);

  /** Opening a new grade is reading it: its dot goes, as an opened message's does. */
  function toggle(g) {
    open = open === g.id ? null : g.id;
    if (g.fresh) {
      g.fresh = false;
      markGradeSeen(login, g.id);
    }
  }
</script>

<Async r={subjects} empty="Brak ocen.">
  {#snippet children(list)}
    {#if list.some((s) => s.rows.flat().some((g) => g.fresh))}
      <p class="muted fresh-key"><span class="dot new"></span>nowa ocena: kropka znika po jej otwarciu</p>
    {/if}
    <div class="card sheet">
      {#each list as s (s.key)}
        <section>
          <div class="head">
            <h2>{s.name}{#if s.hint}<small class="muted">{s.hint}</small>{/if}</h2>
            {#if s.avg.length}<span>śr. {s.avg.map(([k, v]) => `${k} ${v}`).join(', ')}</span>{/if}
          </div>
          <div class="lines">
            {#each [['I sem.', s.rows[1]], ['II sem.', s.rows[2]], ['Opis', s.rows[0]]] as [label, grades] (label)}
              {#if grades.length}
                <div class="row">
                  <span class="muted label">{label}</span>
                  <ul class="chips">
                    {#each grades as g (g.id)}
                      <li>
                        <button class="chip {g.tone}" class:fresh={g.fresh} aria-label="Ocena {g.value}{g.fresh ? ', nowa' : ''}" aria-expanded={open === g.id} onclick={() => toggle(g)}>
                          <Mark value={g.value} />
                        </button>
                      </li>
                    {/each}
                  </ul>
                </div>
                {#each grades.filter((g) => g.id === open) as g (g.id)}
                  <p class="detail">
                    <span class="what">{g.category || 'Bez kategorii'}{#if g.weight}{` · waga ${g.weight}`}{/if}</span><br />
                    {fmtDate(g.date)}{#if g.teacher}{` · ${g.teacher}`}{/if}
                    {#if g.text}<br />{g.text}{/if}
                    {#if g.comment}<br />{g.comment}{/if}
                  </p>
                {/each}
              {/if}
            {/each}
            <!-- A final grade in the same two columns: its kind where "I sem." stands, the grade under the chips. -->
            {#each s.final as g (g.id)}
              <p class="row final">
                <span class="muted label">{g.kind.replace(/^Ocena (\p{L})/u, (_, c) => c.toUpperCase())}</span>
                <strong class="chip static final {g.tone}"><Mark value={g.value} /></strong>
              </p>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/snippet}
</Async>
