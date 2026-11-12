<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDate, fmtPercent, choiceOf, ATTENDANCE } from './util.js';
  import Async from './Async.svelte';

  let { login } = $props();

  // Standard attendance types in Synergia; school-defined types point at one through StandardType.
  const PRESENCE = 100;
  const UNEXCUSED = 1;
  const ABSENCES = new Set([UNEXCUSED, 3]);
  /** The tint of a kind's mark, as picked in "Ustawienia" (util.js); a kind a school made up is grey. */
  const tones = new Map([...ATTENDANCE].map(([std, kind]) => [std, choiceOf(kind)]));
  const tone = (std) => tones.get(std) ?? 'g0';
  const pct = (absent, all) => (all ? fmtPercent((all - absent) / all) : '');

  async function load(login) {
    const [a, t, ls, s] = await Promise.all([
      synergia(login, 'Attendances'),
      lookup(login, 'Attendances/Types'),
      lookup(login, 'Lessons'),
      lookup(login, 'Subjects'),
    ]);
    const [types, lessons, subjects] = [byId(t.Types), byId(ls.Lessons), byId(s.Subjects)];
    const all = (a.Attendances ?? []).map((x) => {
      const type = types.get(String(x.Type?.Id));
      const std = Number(type ? (type.Standard ? type.Id : type.StandardType?.Id) : x.Type?.Id);
      const subject = subjects.get(String(lessons.get(String(x.Lesson?.Id))?.Subject?.Id))?.Name ?? 'Inne';
      return { id: x.Id, date: x.Date, no: x.LessonNo, std, subject, name: type?.Name ?? 'Nieznany', short: type?.Short ?? '?' };
    });
    const entries = all
      .filter((x) => x.std !== PRESENCE)
      .sort((p, q) => q.date.localeCompare(p.date) || Number(q.no) - Number(p.no));
    // Both kinds of absence are always listed, a zero included: whether any is unexcused is what the screen is for.
    const kinds = new Map([...ATTENDANCE].map(([std, k]) => [std, { std, label: k.label, word: k.word, short: types.get(String(std))?.Short ?? '', n: 0 }]));
    for (const e of entries) {
      // A kind this list does not know keeps the school's own name for it.
      if (!kinds.has(e.std)) kinds.set(e.std, { std: e.std, label: e.name, short: e.short, n: 0 });
      kinds.get(e.std).n++;
    }
    const per = new Map();
    for (const x of all) {
      const v = per.get(x.subject) ?? { all: 0, absent: 0, unexcused: 0 };
      v.all++;
      if (ABSENCES.has(x.std)) v.absent++;
      if (x.std === UNEXCUSED) v.unexcused++;
      per.set(x.subject, v);
    }
    const absent = all.filter((x) => ABSENCES.has(x.std)).length;
    return {
      total: pct(absent, all.length),
      kinds: [...kinds.values()].filter((k) => k.n || ABSENCES.has(k.std)),
      subjects: [...per]
        .map(([name, v]) => ({ name, unexcused: v.unexcused, excused: v.absent - v.unexcused, pct: pct(v.absent, v.all) }))
        .sort((p, q) => q.unexcused - p.unexcused || q.excused - p.excused || p.name.localeCompare(q.name, 'pl')),
      entries,
    };
  }

  const data = resource(() => load(login), () => `attendance/${login}`);
  /** The kind the list of entries is narrowed to, or null for all of them. */
  let only = $state(null);
</script>

<Async r={data}>
  {#snippet children(d)}
    <section class="card">
      <h2>Podsumowanie</h2>
      {#if d.total}<p class="figure"><strong>{d.total}</strong> obecności</p>{/if}
      <ul class="totals">
        {#each d.kinds as k (k.std)}
          <li>
            <span class="kind"><span class="chip static {tone(k.std)}">{k.short}</span> {k.label}</span>
            <strong class:alert={k.std === UNEXCUSED && k.n > 0}>{k.n}</strong>
          </li>
        {/each}
      </ul>
      {#if !d.total}<p class="muted">Brak wpisów frekwencji.</p>{/if}
    </section>
    {#if d.subjects.length}
      <section class="card">
        <h2>Obecność na przedmiotach</h2>
        <ul class="totals">
          {#each d.subjects as s (s.name)}
            <li>
              <span>{s.name}</span>
              <span class="muted">
                {#if s.unexcused}<span class="alert">{s.unexcused} nieuspr.</span>{/if}
                {#if s.excused}<span>{s.excused} uspr.</span>{/if}
                <span class="pct">{s.pct}</span>
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if d.entries.length}
      <section class="card">
        <h2>Wpisy</h2>
        {#if d.kinds.filter((k) => k.n).length > 1}
          <!-- No counts (the summary above has them); words shortened on a phone and a tablet, so the usual kinds fit one row. -->
          <div class="segmented filter" role="group" aria-label="Rodzaj wpisu">
            <button aria-pressed={only === null} onclick={() => (only = null)}>Wszystkie</button>
            {#each d.kinds.filter((k) => k.n) as k (k.std)}
              <button aria-pressed={only === k.std} aria-label={k.word ? `${k.word}, ${k.label}` : undefined} title={k.label} onclick={() => (only = k.std)}
                >{#if k.word}<span class="narrow">{k.word}</span><span class="wide">{k.label}</span>{:else}{k.label}{/if}</button
              >
            {/each}
          </div>
        {/if}
        <ul class="entries">
          {#each only === null ? d.entries : d.entries.filter((e) => e.std === only) as e (e.id)}
            <li>
              <span class="chip static {tone(e.std)}" title={e.name}>{e.short}</span>
              <span>{e.subject}<small class="muted">{fmtDate(e.date)}, lekcja {e.no}</small></span>
              <span class="vh">{e.name}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/snippet}
</Async>
