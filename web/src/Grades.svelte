<script>
  import { resource } from './api.svelte.js';
  import { fmtDate, fmtAverage, worth, gradeTone, stored, choiceOf, FORCED_KEY, PLUS, MINUS, YEAR } from './util.js';
  import { grades, unseenGrades, markGradeSeen } from './data.js';
  import Async from './Async.svelte';
  import Mark from './Mark.svelte';
  import Icon from './Icon.svelte';
  import { t, locale } from './i18n.js';

  let { login } = $props();
  let open = $state(null);
  /** The semester shown; until picked, the second once it has anything. */
  let chosen = $state(null);

  /** Picked in "Ustawienia" (util.js); the view is made anew on the way back from there. */
  const forced = stored(FORCED_KEY);
  const [plus, minus] = [PLUS, MINUS].map((s) => Number(choiceOf(s)));
  const halves = choiceOf(YEAR) === 'halves';
  const comma = (n) => Number(n).toLocaleString(locale);

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
      // Points never do: a 5 there is five points, and `share` is what counts them.
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
   * The share of the points to be had that the point grades of a list got, in percent, or 0 without any: the sum of
   * the points over the sum of their categories' maxima, weights left out. A grade in percent is that many points of
   * 100, by its category's weight as in `mean`, so a subject graded in percent gets their weighted mean.
   */
  function share(list) {
    let [got, max] = [0, 0];
    for (const g of list) {
      const w = g.percent == null ? 1 : g.weight === null ? +forced : Number(g.weight) || 0;
      const [p, m] = g.points ?? (g.percent == null ? [0, 0] : [g.percent, 100]);
      [got, max] = [got + p * w, max + m * w];
    }
    return max ? (got / max) * 100 : 0;
  }

  /**
   * What the app counts for a subject, by semester and for the year, with the grades tried out in the simulator
   * (`tries`) beside its own. An improved grade counts with its improvement. A subject graded in points alone
   * (`points`) gets the share of them it has, in percent; with grades of both kinds, the 1 to 6 scale's mean.
   */
  function counts(s, tries = []) {
    const [one, two] = [1, 2].map((n) => [...s.rows[n].flatMap((g) => [...(g.was ?? []), g]), ...tries.filter((g) => g.semester === n)]);
    const by = mean([...one, ...two]) ? mean : share;
    const [first, second] = [by(one), by(two)];
    // The year: every grade of it, or the mean of its two semesters' averages where a school counts it so.
    const year = halves && first && second ? (first + second) / 2 : by([...one, ...two]);
    return { Semester1: first, Semester2: second, FullYear: year, points: by === share && year > 0 };
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
    return (sem === 1 ? [[t('I sem.'), 'Semester1']] : [[t('II sem.'), 'Semester2'], [t('rok'), 'FullYear']])
      .map(([k, f]) => `${k} ${before[f] ? fmtAverage(before[f]) : t('brak')} → ${after[f] ? fmtAverage(after[f]) : t('brak')}`)
      .join(', ');
  }

  /**
   * One line about every subject at once: the mean of the averages shown for the semester (the year's with the
   * second), and of the final grades, or of the proposed ones until those are in. Points have a scale of their own
   * and stay out; a single subject is no mean.
   */
  function overall(shown, sem) {
    const say = (what, values) => (values.length > 1 ? t('{what} {average} (z\u00a0{n} przedmiotów)', { what, average: fmtAverage(values.reduce((a, b) => a + b) / values.length), n: values.length }) : '');
    const averages = shown.flatMap((s) => {
      const of = (k) => s.avg.find(([t, name]) => t === sem && name === k)?.[3];
      const n = sem === 1 ? of(t('I sem.')) : (of(t('rok')) ?? of(t('II sem.')));
      return n > 0 && !s.points ? [n] : [];
    });
    const finals = (kind) => shown.flatMap((s) => s.final[sem].filter((g) => g.kind === kind).map((g) => worth(g.value, 0, 0)).filter(Boolean));
    const [final, proposed, ofFinal, ofProposed] =
      sem === 1
        ? [t('Ocena semestralna'), t('Proponowana semestralna'), t('średnia ocen semestralnych'), t('średnia proponowanych ocen semestralnych')]
        : [t('Ocena roczna'), t('Proponowana roczna'), t('średnia ocen rocznych'), t('średnia proponowanych ocen rocznych')];
    const parts = [say(t('średnia ze średnich'), averages), say(ofFinal, finals(final)) || say(ofProposed, finals(proposed))].filter(Boolean);
    return parts.length ? t('Wszystkie przedmioty: {parts}.', { parts: parts.join(', ') }) : '';
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
          hint: g.subject !== 'whole' && g.name === t('Inne') ? g.teacher : '',
          // by `semester`: 0 holds descriptive grades that belong to no semester, shown with either
          rows: [[], [], []],
          // final grades the same way: a semestral one with its semester, a yearly one with the second
          final: [[], [], []],
        });
      }
      const group = groups.get(g.subject);
      g.fresh = fresh.has(g.id);
      if (g.kind) group.final[[t('Ocena roczna'), t('Proponowana roczna')].includes(g.kind) ? 2 : g.semester].push(g);
      else group.rows[g.semester].push(g);
    }
    // A school that hides its averages sends none: then they are counted here (`own`), from the grades and weights.
    // By scale, [the 1 to 6 grades', the points']: an average sent for a subject graded in points says nothing about
    // the others, and the other way round.
    const hidden = [false, true].map((points) => ![...averages.values()].some((av) => Boolean(av.points) === points && [av.Semester1, av.Semester2, av.FullYear].some((v) => Number(v) > 0)));
    for (const s of groups.values()) {
      const counted = counts(s);
      // Forced, a subject with nothing to count (points alone) keeps what Librus sends.
      s.own = (forced || hidden[+counted.points]) && counted.FullYear > 0;
      const av = s.own ? counted : averages.get(s.key);
      // On the scale of points: no part of a mean of 1 to 6 averages, and nothing the simulator's grades fit.
      s.points = Boolean(av?.points);
      // What the app counts in points is a percentage and says so; what Librus sends stays as sent.
      const said = (v) => (avg(v) && s.own && s.points ? `${avg(v)}%` : avg(v));
      // by semester; the year's average with the second's
      s.avg = [
        [1, t('I sem.'), said(av?.Semester1), Number(av?.Semester1)],
        [2, t('II sem.'), said(av?.Semester2), Number(av?.Semester2)],
        [2, t('rok'), said(av?.FullYear), Number(av?.FullYear)],
      ].filter(([, , v]) => v);
    }
    // Named subjects first; "Inne" (subjects Librus does not list) and the descriptive grades of the whole year after them.
    const rank = (s) => (s.key === 'whole' ? 2 : s.name === t('Inne') ? 1 : 0);
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

  /** How the app counts its averages, as picked in "Ustawienia". */
  const rules = (unweighted) =>
    [t('plus +{v}', { v: comma(plus) }), t('minus −{v}', { v: comma(minus) }), unweighted && t('ocena bez wagi raz'), halves && t('rok jako średnia z\u00a0obu semestrów')]
      .filter(Boolean)
      .join(', ');
</script>

<Async r={subjects} empty={t('Brak ocen.')}>
  {#snippet children(list)}
    {@const sem = chosen ?? (list.some((s) => s.rows[2].length || s.final[2].length) ? 2 : 1)}
    {@const shown = list.filter((s) => s.rows[sem].length || s.final[sem].length || s.rows[0].length || s.final[0].length)}
    {@const all = overall(shown, sem)}
    <div class="toolbar">
      <div class="segmented" role="group" aria-label={t('Semestr')}>
        <button aria-pressed={sem === 1} onclick={() => (chosen = 1)}>{t('I semestr')}</button>
        <button aria-pressed={sem === 2} onclick={() => (chosen = 2)}>{t('II semestr')}</button>
      </div>
      <button class="secondary" aria-pressed={simulating} onclick={() => (simulating = !simulating)}>{t('Symulator')}</button>
    </div>
    {#if simulating}
      <p class="overall">{t('Symulator: dodaj przy przedmiocie ocenę na próbę i\u00a0zobacz, co zrobi ze średnią. Średnie przed i\u00a0po liczy aplikacja; ocena na próbę znika po dotknięciu i\u00a0po wyjściu z\u00a0ocen.')}</p>
    {/if}
    {#if shown.some((s) => [...s.rows[sem], ...s.rows[0]].some((g) => g.fresh))}
      <p class="muted fresh-key"><span class="dot new"></span>{t('nowa ocena: kropka znika po jej otwarciu')}</p>
    {/if}
    {#if shown.some((s) => s.own && s.avg.some(([t]) => t === sem))}
      {@const percent = shown.some((s) => s.own && s.points) ? ` ${t('Przy ocenach punktowych to procent zdobytych punktów, przy procentowych ich średnia z wagami.')}` : ''}
      {#if forced}
        <p class="byline">{t('Średnie wylicza aplikacja z\u00a0każdej oceny 1–6 ({rules}), jak wybrano w', { rules: rules(true) })}&nbsp;<a href="#/ustawienia">{t('Ustawieniach')}</a>.{percent} {t('Szkoła może liczyć inaczej.')}</p>
      {:else}
        <p class="byline">{t('Średnie wylicza aplikacja z\u00a0ocen i\u00a0wag, bo Librus ich nie podaje ({rules}).', { rules: rules(false) })}{percent} {t('Szkoła może liczyć inaczej.')}</p>
      {/if}
    {/if}
    {#if all}<p class="overall">{all}</p>{/if}
    {#if !shown.length}
      <p class="center muted">{sem === 1 ? t('Brak ocen w I semestrze.') : t('Brak ocen w II semestrze.')}</p>
    {:else}
      <div class="card sheet">
        {#each shown as s (s.key)}
          {@const avgs = s.avg.filter(([t]) => t === sem)}
          <section>
            <div class="head">
              <h2>{s.name}{#if s.hint}<small class="muted">{s.hint}</small>{/if}</h2>
              <!-- A pair per span, so a line breaks between "II sem. 5,00" and "rok 5,00", never inside one. -->
              {#if avgs.length}<span>{#each avgs as [, k, v], i (k)}{i ? ', ' : ''}<span>{i ? '' : `${t('śr.')} `}{k} {v}</span>{/each}</span>{/if}
            </div>
            <div class="lines">
              {#each [[t('Bieżące'), s.rows[sem]], [t('Opis'), s.rows[0]]] as [label, grades] (label)}
                {#if grades.length}
                  <div class="row">
                    <span class="muted label">{label}</span>
                    <ul class="chips">
                      {#each grades as g (g.id)}
                        <li>
                          <button class="chip {g.tone}" class:fresh={g.fresh} aria-label={t('Ocena {value}', { value: g.value }) + (g.was ? t(', poprawa oceny {value}', { value: g.was.at(-1).value }) : '') + (g.fresh ? t(', nowa') : '')} aria-expanded={open === g.id} onclick={() => toggle(g)}>
                            <Mark value={g.value} was={g.was} />
                          </button>
                        </li>
                      {/each}
                    </ul>
                  </div>
                  {#each grades.filter((g) => g.id === open) as g (g.id)}
                    <p class="detail">
                      <span class="what">{g.category || t('Bez kategorii')}{#if g.weight}{` · ${t('waga {w}', { w: g.weight })}`}{/if}</span><br />
                      {fmtDate(g.date)}{#if g.teacher}{` · ${g.teacher}`}{/if}
                      {#if g.text}<br />{g.text}{/if}
                      {#if g.comment}<br />{g.comment}{/if}
                      {#each (g.was ?? []).toReversed() as w (w.id)}
                        <br />{t('Poprawiona ocena:')} {[w.value, fmtDate(w.date), w.text, w.comment].filter(Boolean).join(' · ')}
                      {/each}
                    </p>
                  {/each}
                {/if}
              {/each}
              {#if simulating && s.key !== 'whole' && !s.points}
                <div class="row">
                  <span class="muted label">{t('Na próbę')}</span>
                  <ul class="chips">
                    {#each (tries[s.key] ?? []).filter((g) => g.semester === sem) as g (g.id)}
                      <li>
                        <button class="chip tried {g.tone}" aria-label={t('Ocena na próbę {value}, waga {w}: usuń', { value: g.value, w: g.weight })} title={t('Waga {w}: usuń', { w: g.weight })} onclick={() => (tries[s.key] = tries[s.key].filter((x) => x !== g))}>
                          <Mark value={g.value} />
                        </button>
                      </li>
                    {/each}
                    <li>
                      <form class="try" onsubmit={(e) => tryOut(e, s.key, sem)}>
                        <select name="value" aria-label={t('Ocena na próbę: {name}', { name: s.name })}>
                          {#each TRY_VALUES as v (v)}<option selected={v === '5'}>{v}</option>{/each}
                        </select>
                        <select name="weight" aria-label={t('Waga oceny na próbę')}>
                          {#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as w (w)}<option value={w}>{t('waga {w}', { w })}</option>{/each}
                        </select>
                        <button class="secondary" disabled={(tries[s.key]?.length ?? 0) >= TRY_MAX} aria-label={t('Dodaj ocenę na próbę: {name}', { name: s.name })} title={t('Dodaj ocenę na próbę')}><Icon name="plus" size={18} /></button>
                      </form>
                    </li>
                  </ul>
                </div>
                {#if tries[s.key]?.length}<p class="overall" role="status">{t('Po zmianie: {outcome}', { outcome: outcome(s, sem) })}</p>{/if}
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
