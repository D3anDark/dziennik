<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDate } from './util.js';
  import Async from './Async.svelte';

  let { login } = $props();

  // Standard attendance types in Synergia; school-defined types point at one through StandardType.
  const PRESENCE = 100;
  const ABSENCES = new Set([1, 3]);
  const pct = (absent, all) => (all ? `${(((all - absent) / all) * 100).toFixed(1)}%` : '');

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
    const counts = new Map();
    for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    const per = new Map();
    for (const x of all) {
      const v = per.get(x.subject) ?? { all: 0, absent: 0 };
      v.all++;
      if (ABSENCES.has(x.std)) v.absent++;
      per.set(x.subject, v);
    }
    const absent = all.filter((x) => ABSENCES.has(x.std)).length;
    return {
      total: pct(absent, all.length),
      totals: [...counts].sort((p, q) => q[1] - p[1]),
      subjects: [...per]
        .map(([name, v]) => ({ name, absent: v.absent, pct: pct(v.absent, v.all) }))
        .sort((p, q) => q.absent - p.absent || p.name.localeCompare(q.name, 'pl')),
      entries,
    };
  }

  const data = resource(() => load(login));
</script>

<Async r={data}>
  {#snippet children(d)}
    <section class="card">
      <h2>Podsumowanie</h2>
      <ul class="totals">
        {#if d.total}
          <li><span>Frekwencja</span><strong>{d.total}</strong></li>
        {/if}
        {#each d.totals as [name, n] (name)}
          <li><span>{name}</span><strong>{n}</strong></li>
        {/each}
      </ul>
      {#if !d.total}<p class="muted">Brak wpisów frekwencji.</p>{/if}
    </section>
    {#if d.subjects.length}
      <section class="card">
        <h2>Przedmioty</h2>
        <ul class="totals">
          {#each d.subjects as s (s.name)}
            <li><span>{s.name}</span><span class="muted">{s.absent} nb, {s.pct}</span></li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if d.entries.length}
      <section class="card">
        <h2>Wpisy</h2>
        <ul class="entries">
          {#each d.entries as e (e.id)}
            <li>
              <span class="chip static" title={e.name}>{e.short}</span>
              <span>{fmtDate(e.date)}, lekcja {e.no}<small class="muted">{e.subject}</small></span>
              <span class="muted">{e.name}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/snippet}
</Async>
