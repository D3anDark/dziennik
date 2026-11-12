<script>
  import { resource } from './api.svelte.js';
  import { fmtDate, fmtAverage, worth } from './util.js';
  import { grades, unseenGrades, markGradeSeen } from './data.js';
  import Async from './Async.svelte';
  import Mark from './Mark.svelte';

  let { login } = $props();
  let open = $state(null);
  /** The semester shown; until picked, the second once it has anything. */
  let chosen = $state(null);

  /** Librus sends "0.00" (or nothing) when a school hides averages. */
  const avg = (v) => (Number(v) > 0 ? fmtAverage(Number(v)) : null);

  /**
   * The weighted mean of the 1 to 6 grades whose category counts to the average, or 0 without any.
   * shortcut: a plus and a minus at fixed values (`worth`), an improved grade counted beside its improvement, whatever
   * the school has set; upgrade once those settings are read from Librus.
   */
  function mean(list) {
    let [sum, weights] = [0, 0];
    for (const g of list) {
      // Only the 1 to 6 scale has a tone (data.js); points, words and marks like "np" have no place in this mean.
      if (g.tone === 'g0' || g.weight === null) continue;
      const w = Number(g.weight) || 0;
      sum += worth(g.value) * w;
      weights += w;
    }
    return weights ? sum / weights : 0;
  }

  async function load(login) {
    const { items, averages } = await grades(login);
    const groups = new Map();
    const fresh = unseenGrades(login, items);
    for (const g of items) {
      if (!groups.has(g.subject)) {
        groups.set(g.subject, {
          key: g.subject,
          name: g.name,
          // Subjects missing from Librus' list are all "Inne"; whoever gave the grades tells them apart.
          hint: g.subject !== 'whole' && g.name === 'Inne' ? g.teacher : '',
          // by `semester`: 0 holds descriptive grades that belong to no semester, shown with either
          rows: [[], [], []],
          // final grades the same way: a semestral one with its semester, a yearly one with the second
          final: [[], [], []],
        });
      }
      const group = groups.get(g.subject);
      g.fresh = fresh.has(g.id);
      if (g.kind) group.final[/roczna/.test(g.kind) ? 2 : g.semester].push(g);
      else group.rows[g.semester].push(g);
    }
    // A school that hides its averages sends none: then they are counted here (`own`), from the grades and weights.
    const own = ![...averages.values()].some((av) => [av.Semester1, av.Semester2, av.FullYear].some((v) => Number(v) > 0));
    for (const s of groups.values()) {
      // An improved grade counts with its improvement.
      const [one, two] = [s.rows[1], s.rows[2]].map((row) => row.flatMap((g) => [...(g.was ?? []), g]));
      const av = own ? { Semester1: mean(one), Semester2: mean(two), FullYear: mean([...one, ...two]) } : averages.get(s.key);
      // by semester; the year's average with the second's
      s.avg = [
        [1, 'I sem.', avg(av?.Semester1)],
        [2, 'II sem.', avg(av?.Semester2)],
        [2, 'rok', avg(av?.FullYear)],
      ].filter(([, , v]) => v);
      s.own = own;
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
    {@const sem = chosen ?? (list.some((s) => s.rows[2].length || s.final[2].length) ? 2 : 1)}
    {@const shown = list.filter((s) => s.rows[sem].length || s.final[sem].length || s.rows[0].length || s.final[0].length)}
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="Semestr">
        <button aria-pressed={sem === 1} onclick={() => (chosen = 1)}>I semestr</button>
        <button aria-pressed={sem === 2} onclick={() => (chosen = 2)}>II semestr</button>
      </div>
    </div>
    {#if shown.some((s) => [...s.rows[sem], ...s.rows[0]].some((g) => g.fresh))}
      <p class="muted fresh-key"><span class="dot new"></span>nowa ocena: kropka znika po jej otwarciu</p>
    {/if}
    {#if shown.some((s) => s.own && s.avg.some(([t]) => t === sem))}
      <p class="byline">Średnie wylicza aplikacja z&nbsp;ocen i&nbsp;wag, bo Librus ich nie podaje (plus +0,5, minus −0,25). Szkoła może liczyć inaczej.</p>
    {/if}
    {#if !shown.length}
      <p class="center muted">Brak ocen w {sem === 1 ? 'I' : 'II'} semestrze.</p>
    {:else}
      <div class="card sheet">
        {#each shown as s (s.key)}
          {@const avgs = s.avg.filter(([t]) => t === sem)}
          <section>
            <div class="head">
              <h2>{s.name}{#if s.hint}<small class="muted">{s.hint}</small>{/if}</h2>
              <!-- A pair per span, so a line breaks between "II sem. 5,00" and "rok 5,00", never inside one. -->
              {#if avgs.length}<span>{#each avgs as [, k, v], i (k)}{i ? ', ' : ''}<span>{i ? '' : 'śr. '}{k} {v}</span>{/each}</span>{/if}
            </div>
            <div class="lines">
              {#each [['Bieżące', s.rows[sem]], ['Opis', s.rows[0]]] as [label, grades] (label)}
                {#if grades.length}
                  <div class="row">
                    <span class="muted label">{label}</span>
                    <ul class="chips">
                      {#each grades as g (g.id)}
                        <li>
                          <button class="chip {g.tone}" class:fresh={g.fresh} aria-label="Ocena {g.value}{g.was ? `, poprawa oceny ${g.was.at(-1).value}` : ''}{g.fresh ? ', nowa' : ''}" aria-expanded={open === g.id} onclick={() => toggle(g)}>
                            <Mark value={g.value} was={g.was} />
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
                      {#each (g.was ?? []).toReversed() as w (w.id)}
                        <br />Poprawiona ocena: {[w.value, fmtDate(w.date), w.text, w.comment].filter(Boolean).join(' · ')}
                      {/each}
                    </p>
                  {/each}
                {/if}
              {/each}
              <!-- A final grade in the same two columns: its kind where "Bieżące" stands, the grade under the chips. -->
              {#each [...s.final[sem], ...s.final[0]] as g (g.id)}
                <p class="row final">
                  <span class="muted label">{g.kind.replace(/^Ocena (\p{L})/u, (_, c) => c.toUpperCase())}</span>
                  <strong class="chip static final {g.tone}"><Mark value={g.value} /></strong>
                </p>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  {/snippet}
</Async>
