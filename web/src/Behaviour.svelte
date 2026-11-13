<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDate, person, plain } from './util.js';
  import Async from './Async.svelte';
  import { t } from './i18n.js';

  let { login } = $props();

  async function load(login) {
    const soft = () => ({});
    // Schools use either behaviour grades or a points system; whichever is off answers with an error.
    const [g, ty, p, pc, cm, u] = await Promise.all([
      synergia(login, 'BehaviourGrades').catch(soft),
      lookup(login, 'BehaviourGrades/Types'),
      synergia(login, 'BehaviourGrades/Points').catch(soft),
      lookup(login, 'BehaviourGrades/Points/Categories'),
      synergia(login, 'BehaviourGrades/Points/Comments').catch(soft),
      lookup(login, 'Users'),
    ]);
    const [types, cats, users] = [byId(ty.Types), byId(pc.Categories), byId(u.Users)];
    const comments = new Map((cm.Comments ?? []).map((c) => [String(c.Grade?.Id), plain(c.Text)]));
    /** "od -10 do -5 pkt", or just the value when the category has one. */
    const range = (c) => (c?.ValueTo == null ? '' : c.ValueFrom === c.ValueTo ? t('{n} pkt', { n: c.ValueTo }) : t('od {from} do {to} pkt', { from: c.ValueFrom, to: c.ValueTo }));
    const grades = (g.Grades ?? []).map((x) => {
      const type = types.get(String(x.GradeType?.Id));
      return {
        id: x.Id,
        label: x.IsProposal === '1' ? (x.Semester === '1' ? t('Proponowana śródroczna') : t('Proponowana roczna')) : x.Semester === '1' ? t('śródroczna') : t('roczna'),
        value: type?.Name ?? type?.Shortcut ?? '?',
      };
    });
    const points = (p.Grades ?? []).map((x) => ({
      id: x.Id,
      // An entry is a number of points or, at schools that grade with symbols, only a ShortName (or a behaviour grade).
      value: x.Value == null || x.Value === '' ? null : Number(x.Value),
      shown: x.ShortName || x.Value || types.get(String(x.BehaviourGrade?.Id))?.Name,
      category: [cats.get(String(x.Category?.Id))?.Name, range(cats.get(String(x.Category?.Id)))].filter(Boolean).join(', '),
      text: comments.get(String(x.Id)) ?? '',
      date: x.Date ?? x.AddDate ?? '',
      who: x.AddedBy?.Id ? person(users.get(String(x.AddedBy.Id))) : '',
      sem: Number(x.Semester) === 2 ? 2 : 1,
    }));
    const sems = [...new Set(points.map((x) => x.sem))].sort();
    // The points a semester starts with, as the school set them for the class's unit (Units); the second's as the
    // first's unless set. Each is an entry of its semester.
    const unit = points.length ? (await lookup(login, 'Classes')).Class?.Unit?.Id : null;
    if (unit != null) {
      const set = ((await lookup(login, 'Units')).Units ?? []).find((x) => String(x.Id) === String(unit))?.BehaviourGradesSettings?.StartPoints;
      const start = [Number(set?.Semester1) || 0];
      start.push(set?.Semester2 == null ? start[0] : Number(set.Semester2) || 0);
      for (const sem of sems)
        if (start[sem - 1]) points.push({ id: `start-${sem}`, value: start[sem - 1], shown: String(start[sem - 1]), category: t('Punkty startowe'), text: sem === 1 ? t('I semestr') : t('II semestr'), date: '', who: '', sem });
    }
    // The later semester first, its newest entry at the top and its start points at the bottom.
    points.sort((a, b) => b.sem - a.sem || b.date.localeCompare(a.date));
    // A total of some entries only would pass for the real one, so it is shown when every entry has points. By
    // semester: each starts again.
    const sum = points.some((x) => x.value === null)
      ? null
      : sems.map((sem) => [sem, points.filter((x) => x.sem === sem).reduce((s, x) => s + x.value, 0)]);
    return grades.length || points.length ? { grades, points, sum } : [];
  }

  const data = resource(() => load(login), () => `behaviour/${login}`);
</script>

<Async r={data} empty={t('Brak ocen z zachowania.')}>
  {#snippet children(d)}
    {#if d.grades.length}
      <section class="card">
        <h2>{t('Oceny z zachowania')}</h2>
        <ul class="totals">
          {#each d.grades as x (x.id)}
            <li><span>{x.label}</span><strong>{x.value}</strong></li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if d.points.length}
      <section class="card">
        <h2>{d.sum === null ? t('Punkty i wpisy') : t('Punkty: {sum}', { sum: d.sum.length > 1 ? d.sum.map(([sem, n]) => `${sem === 1 ? t('I sem.') : t('II sem.')} ${n}`).join(', ') : d.sum[0][1] })}</h2>
        <ul class="entries">
          {#each d.points as x (x.id)}
            <li>
              <span class="chip static">{x.shown}</span>
              <span>{x.category}<small class="muted">{[fmtDate(x.date), x.who, x.text].filter(Boolean).join(' · ')}</small></span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/snippet}
</Async>
