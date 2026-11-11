<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDay, person, plain } from './util.js';
  import Async from './Async.svelte';
  import Rich from './Rich.svelte';

  let { login } = $props();

  // Realizations holds the whole school year, over a thousand lessons: render two school weeks, more on demand.
  const STEP = 10;
  let shown = $state(STEP);

  async function load(login) {
    const [r, ls, s, u] = await Promise.all([
      synergia(login, 'Realizations'),
      lookup(login, 'Lessons'),
      lookup(login, 'Subjects'),
      lookup(login, 'Users'),
    ]);
    const [lessons, subjects, users] = [byId(ls.Lessons), byId(s.Subjects), byId(u.Users)];
    const days = new Map();
    for (const x of r.Realizations ?? []) {
      if (!x.Date) continue;
      const lesson = lessons.get(String(x.Lesson?.Id));
      if (!days.has(x.Date)) days.set(x.Date, []);
      days.get(x.Date).push({
        id: x.Id,
        no: x.LessonNo,
        subject: subjects.get(String(lesson?.Subject?.Id))?.Name ?? 'Lekcja',
        teacher: lesson?.Teacher?.Id ? person(users.get(String(lesson.Teacher.Id))) : '',
        topic: plain(x.Topic),
      });
    }
    return [...days]
      .sort((p, q) => q[0].localeCompare(p[0]))
      .map(([date, list]) => ({ date, list: list.sort((p, q) => Number(p.no) - Number(q.no)) }));
  }

  const days = resource(() => load(login), () => `topics/${login}`);
</script>

<Async r={days} empty="Brak tematów lekcji.">
  {#snippet children(all)}
    {#each all.slice(0, shown) as d (d.date)}
      <section class="card">
        <h2 class="day">{fmtDay(d.date)}</h2>
        <ul class="events">
          {#each d.list as l (l.id)}
            <li>
              <strong>{l.subject}</strong>
              <small class="muted">{[l.no && `lekcja ${l.no}`, l.teacher].filter(Boolean).join(' · ')}</small>
              {#if l.topic}<Rich text={l.topic} />{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/each}
    {#if all.length > shown}
      <button class="secondary" onclick={() => (shown += STEP)}>Pokaż starsze</button>
    {/if}
  {/snippet}
</Async>
