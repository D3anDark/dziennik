<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDate, person, plain } from './util.js';
  import Async from './Async.svelte';

  let { login } = $props();

  async function load(login) {
    const soft = () => ({});
    // Schools use either behaviour grades or a points system; whichever is off answers with an error.
    const [g, t, p, pc, u] = await Promise.all([
      synergia(login, 'BehaviourGrades').catch(soft),
      lookup(login, 'BehaviourGrades/Types'),
      synergia(login, 'BehaviourGrades/Points').catch(soft),
      lookup(login, 'BehaviourGrades/Points/Categories'),
      lookup(login, 'Users'),
    ]);
    const [types, cats, users] = [byId(t.Types), byId(pc.Categories), byId(u.Users)];
    const grades = (g.Grades ?? []).map((x) => {
      const type = types.get(String(x.GradeType?.Id));
      return {
        id: x.Id,
        label: `${x.IsProposal === '1' ? 'Proponowana ' : ''}${x.Semester === '1' ? 'śródroczna' : 'roczna'}`,
        value: type?.Name ?? type?.Shortcut ?? '?',
      };
    });
    const points = (p.Grades ?? [])
      .map((x) => ({
        id: x.Id,
        value: Number(x.Value) || 0,
        shown: x.ShortName || x.Value,
        category: cats.get(String(x.Category?.Id))?.Name ?? '',
        text: plain(x.Text),
        date: x.Date ?? x.AddDate ?? '',
        who: x.AddedBy?.Id ? person(users.get(String(x.AddedBy.Id))) : '',
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    return grades.length || points.length ? { grades, points, sum: points.reduce((s, x) => s + x.value, 0) } : [];
  }

  const data = resource(() => load(login));
</script>

<Async r={data} empty="Brak ocen z zachowania.">
  {#snippet children(d)}
    {#if d.grades.length}
      <section class="card">
        <h2>Oceny z zachowania</h2>
        <ul class="totals">
          {#each d.grades as x (x.id)}
            <li><span>{x.label}</span><strong>{x.value}</strong></li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if d.points.length}
      <section class="card">
        <h2>Punkty: {d.sum}</h2>
        <ul class="entries">
          {#each d.points as x (x.id)}
            <li>
              <span class="chip static">{x.shown}</span>
              <span>{x.category}<small class="muted">{[fmtDate(x.date), x.who, x.text].filter(Boolean).join(', ')}</small></span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/snippet}
</Async>
