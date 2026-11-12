<script>
  import { resource } from './api.svelte.js';
  import { fmtDate, fmtAverage, worth, gradeTone, stored, choiceOf, FORCED_KEY, PLUS, MINUS, YEAR } from './util.js';
  import { grades, unseenGrades, markGradeSeen } from './data.js';
  import Async from './Async.svelte';
  import Mark from './Mark.svelte';
  import Icon from './Icon.svelte';

  let { login } = $props();
  let open = $state(null);
  /** The semester shown; until picked, the second once it has anything. */
  let chosen = $state(null);

  /** Picked in "Ustawienia" (util.js); the view is made anew on the way back from there. */
  const forced = stored(FORCED_KEY);
  const [plus, minus] = [PLUS, MINUS].map((s) => Number(choiceOf(s)));
  const halves = choiceOf(YEAR) === 'halves';
  const comma = (n) => String(n).replace('.', ',');

  /** Librus sends "0.00" (or nothing) when a school hides averages. */
  const avg = (v) => (Number(v) > 0 ? fmtAverage(Number(v)) : null);

  /**
   * The weighted mean of the 1 to 6 grades whose category counts to the average, or 0 without any.
   * shortcut: a plus and a minus as picked in "Ustawienia" for every subject, an improved grade counted beside its
   * improvement, whatever the school has set; upgrade once those settings are read from Librus.
   */
  function mean(list) {
    let [sum, weights, plain, n] = [0, 0, 0, 0];
    for (const g of list) {
      // Only the 1 to 6 scale has a tone (data.js); points, words and marks like "np" have no place in this mean.
      // Forced, a grade of any other system that reads as 1 to 6 counts too, and one without a weight counts once.
      // Points never do: a 5 there is five points.
      if (forced ? worth(g.value) === null || g.id.startsWith('PointGrades/') : g.tone === 'g0' || g.weight === null) continue;
      const [v, w] = [worth(g.value, plus, minus), Number(g.weight ?? 1) || 0];
      sum += v * w;
      weights += w;
      plain += v;
      n++;
    }
    // Forced, grades whose weights are all 0 (a school's way of keeping a subject out) count once each.
    return weights ? sum / weights : forced && n ? plain / n : 0;
  }

  /**
   * What the app counts for a subject, by semester and for the year, with the grades tried out in the simulator
   * (`tries`) beside its own. An improved grade counts with its improvement.
   */
  function counts(s, tries = []) {
    const [one, two] = [1, 2].map((n) => [...s.rows[n].flatMap((g) => [...(g.was ?? []), g]), ...tries.filter((g) => g.semester === n)]);
    const [first, second] = [mean(one), mean(two)];
    // The year: every grade of it, or the mean of its two semesters' averages where a school counts it so.
    return { Semester1: first, Semester2: second, FullYear: halves && first && second ? (first + second) / 2 : mean([...one, ...two]) };
  }

  /**
   * The simulator: grades tried out, by subject, to see what they would do to its average. Kept for this visit only,
   * at most TRY_MAX a subject.
   */
  const TRY_MAX = 20;
  const TRY_VALUES = ['6', '6-', '5+', '5', '5-', '4+', '4', '4-', '3+', '3', '3-', '2+', '2', '2-', '1+', '1'];
  let simulating = $state(false);
  let tries = $state({});
  let tried = 0;

  function tryOut(e, key, semester) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const value = String(form.get('value'));
    tries[key] = [...(tries[key] ?? []), { id: `try/${++tried}`, value, weight: Number(form.get('weight')), tone: gradeTone(value), semester }];
  }

  /** The semester's average of a subject as the app counts it, and what it becomes with the grades tried out. */
  function outcome(s, sem) {
    const [before, after] = [counts(s), counts(s, tries[s.key])];
    return (sem === 1 ? [['I sem.', 'Semester1']] : [['II sem.', 'Semester2'], ['rok', 'FullYear']])
      .map(([k, f]) => `${k} ${before[f] ? fmtAverage(before[f]) : 'brak'} → ${after[f] ? fmtAverage(after[f]) : 'brak'}`)
      .join(', ');
  }

  /**
   * One line about every subject at once: the mean of the averages shown for the semester (the year's with the
   * second), and of the final grades, or of the proposed ones until those are in. Points have a scale of their own
   * and stay out; a single subject is no mean.
   */
  function overall(shown, sem) {
    const say = (what, values) => (values.length > 1 ? `${what} ${fmtAverage(values.reduce((a, b) => a + b) / values.length)} (z\u00a0${values.length} przedmiotów)` : '');
    const averages = shown.flatMap((s) => {
      const of = (k) => s.avg.find(([t, name]) => t === sem && name === k)?.[3];
      const n = sem === 1 ? of('I sem.') : (of('rok') ?? of('II sem.'));
      return n >= 1 && n <= 6 ? [n] : [];
    });
    const finals = (kind) => shown.flatMap((s) => s.final[sem].filter((g) => g.kind === kind).map((g) => worth(g.value, 0, 0)).filter(Boolean));
    const [final, proposed, word] = sem === 1 ? ['Ocena semestralna', 'Proponowana semestralna', 'semestralnych'] : ['Ocena roczna', 'Proponowana roczna', 'rocznych'];
    const parts = [
      say('średnia ze średnich', averages),
      say(`średnia ocen ${word}`, finals(final)) || say(`średnia proponowanych ocen ${word}`, finals(proposed)),
    ].filter(Boolean);
    return parts.length ? `Wszystkie przedmioty: ${parts.join(', ')}.` : '';
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
    const hidden = ![...averages.values()].some((av) => [av.Semester1, av.Semester2, av.FullYear].some((v) => Number(v) > 0));
    for (const s of groups.values()) {
      const counted = counts(s);
      // Forced, a subject with nothing to count (points alone) keeps what Librus sends.
      s.own = (hidden || forced) && counted.FullYear > 0;
      const av = s.own ? counted : averages.get(s.key);
      // by semester; the year's average with the second's
      s.avg = [
        [1, 'I sem.', avg(av?.Semester1), Number(av?.Semester1)],
        [2, 'II sem.', avg(av?.Semester2), Number(av?.Semester2)],
        [2, 'rok', avg(av?.FullYear), Number(av?.FullYear)],
      ].filter(([, , v]) => v);
    }
    // Named subjects first; "Inne" (subjects Librus does not list) and the descriptive grades of the whole year after them.
    const rank = (s) => (s.key === 'whole' ? 2 : s.name === 'Inne' ? 1 : 0);
    return [...groups.values()].sort((p, q) => rank(p) - rank(q) || p.name.localeCompare(q.name, 'pl'));
  }

  // The settings are part of what the answer depends on: one kept from before a switch is not shown after it.
  const subjects = resource(() => load(login), () => `grades/${login}/${+forced}/${plus}/${minus}/${+halves}`);

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
    {@const all = overall(shown, sem)}
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="Semestr">
        <button aria-pressed={sem === 1} onclick={() => (chosen = 1)}>I semestr</button>
        <button aria-pressed={sem === 2} onclick={() => (chosen = 2)}>II semestr</button>
      </div>
      <button class="secondary" aria-pressed={simulating} onclick={() => (simulating = !simulating)}>Symulator</button>
    </div>
    {#if simulating}
      <p class="overall">Symulator: dodaj przy przedmiocie ocenę na próbę i&nbsp;zobacz, co zrobi ze średnią. Średnie przed i&nbsp;po liczy aplikacja; ocena na próbę znika po dotknięciu i&nbsp;po wyjściu z&nbsp;ocen.</p>
    {/if}
    {#if shown.some((s) => [...s.rows[sem], ...s.rows[0]].some((g) => g.fresh))}
      <p class="muted fresh-key"><span class="dot new"></span>nowa ocena: kropka znika po jej otwarciu</p>
    {/if}
    {#if shown.some((s) => s.own && s.avg.some(([t]) => t === sem))}
      {#if forced}
        <p class="byline">Średnie wylicza aplikacja z&nbsp;każdej oceny 1–6 poza punktowymi (plus +{comma(plus)}, minus −{comma(minus)}, ocena bez wagi raz{halves ? ', rok jako średnia z\u00a0obu semestrów' : ''}), jak wybrano w&nbsp;<a href="#/ustawienia">Ustawieniach</a>. Szkoła może liczyć inaczej.</p>
      {:else}
        <p class="byline">Średnie wylicza aplikacja z&nbsp;ocen i&nbsp;wag, bo Librus ich nie podaje (plus +{comma(plus)}, minus −{comma(minus)}{halves ? ', rok jako średnia z\u00a0obu semestrów' : ''}). Szkoła może liczyć inaczej.</p>
      {/if}
    {/if}
    {#if all}<p class="overall">{all}</p>{/if}
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
              {#if simulating && s.key !== 'whole'}
                <div class="row">
                  <span class="muted label">Na próbę</span>
                  <ul class="chips">
                    {#each (tries[s.key] ?? []).filter((g) => g.semester === sem) as g (g.id)}
                      <li>
                        <button class="chip tried {g.tone}" aria-label="Ocena na próbę {g.value}, waga {g.weight}: usuń" title="Waga {g.weight}: usuń" onclick={() => (tries[s.key] = tries[s.key].filter((x) => x !== g))}>
                          <Mark value={g.value} />
                        </button>
                      </li>
                    {/each}
                    <li>
                      <form class="try" onsubmit={(e) => tryOut(e, s.key, sem)}>
                        <select name="value" aria-label="Ocena na próbę: {s.name}">
                          {#each TRY_VALUES as v (v)}<option selected={v === '5'}>{v}</option>{/each}
                        </select>
                        <select name="weight" aria-label="Waga oceny na próbę">
                          {#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as w (w)}<option value={w}>waga {w}</option>{/each}
                        </select>
                        <button class="secondary" disabled={(tries[s.key]?.length ?? 0) >= TRY_MAX} aria-label="Dodaj ocenę na próbę: {s.name}" title="Dodaj ocenę na próbę"><Icon name="plus" size={18} /></button>
                      </form>
                    </li>
                  </ul>
                </div>
                {#if tries[s.key]?.length}<p class="overall" role="status">Po zmianie: {outcome(s, sem)}</p>{/if}
              {/if}
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
