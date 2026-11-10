<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDate, person, plain } from './util.js';
  import Async from './Async.svelte';

  let { login } = $props();

  async function load(login) {
    const soft = () => ({});
    // Schools use either behaviour grades or a points system; whichever is off answers with an error.
    const [g, t, p, pc, cm, u] = await Promise.all([
      synergia(login, 'BehaviourGrades').catch(soft),
      lookup(login, 'BehaviourGrades/Types'),
      synergia(login, 'BehaviourGrades/Points').catch(soft),
      lookup(login, 'BehaviourGrades/Points/Categories'),
      synergia(login, 'BehaviourGrades/Points/Comments').catch(soft),
      lookup(login, 'Users'),
    ]);
    const [types, cats, users] = [byId(t.Types), byId(pc.Categories), byId(u.Users)];
    const comments = new Map((cm.Comments ?? []).map((c) => [String(c.Grade?.Id), plain(c.Text)]));
    /** "od -10 do -5 pkt", or just the value when the category has one. */
    const range = (c) => (c?.ValueTo == null ? '' : c.ValueFrom === c.ValueTo ? `${c.ValueTo} pkt` : `od ${c.ValueFrom} do ${c.ValueTo} pkt`);
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
        // An entry is a number of points or, at schools that grade with symbols, only a ShortName.
        value: x.Value == null || x.Value === '' ? null : Number(x.Value),
        shown: x.ShortName || x.Value,
        category: [cats.get(String(x.Category?.Id))?.Name, range(cats.get(String(x.Category?.Id)))].filter(Boolean).join(', '),
        text: comments.get(String(x.Id)) ?? '',
        date: x.Date ?? x.AddDate ?? '',
        who: x.AddedBy?.Id ? person(users.get(String(x.AddedBy.Id))) : '',
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    // A total of some entries only would pass for the real one, so it is shown when every entry has points.
    const sum = points.some((x) => x.value === null) ? null : points.reduce((s, x) => s + x.value, 0);
    return grades.length || points.length ? { grades, points, sum } : [];
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
        <h2>{d.sum === null ? 'Punkty i wpisy' : `Punkty: ${d.sum}`}</h2>
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
