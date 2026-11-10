<script>
  import { lookup, resource, byId } from './api.svelte.js';
  import { person } from './util.js';
  import Async from './Async.svelte';

  let { login } = $props();

  async function load(login) {
    const [ls, s, u] = await Promise.all([lookup(login, 'Lessons'), lookup(login, 'Subjects'), lookup(login, 'Users')]);
    if (!ls.Lessons) throw new Error('upstream');
    const [subjects, users] = [byId(s.Subjects), byId(u.Users)];
    const bySubject = new Map();
    for (const l of ls.Lessons) {
      const name = subjects.get(String(l.Subject?.Id))?.Name ?? 'Inne';
      if (!bySubject.has(name)) bySubject.set(name, new Set());
      if (l.Teacher?.Id) bySubject.get(name).add(person(users.get(String(l.Teacher.Id))));
    }
    return [...bySubject]
      .map(([name, t]) => ({ name, teachers: [...t].join(', ') }))
      .sort((p, q) => p.name.localeCompare(q.name, 'pl'));
  }

  const list = resource(() => load(login));

  /** Class and school rows from Classes and Schools; every part is optional, so a refusal just leaves it out. */
  async function about(login) {
    const [c, s, u] = await Promise.all([lookup(login, 'Classes'), lookup(login, 'Schools'), lookup(login, 'Users')]);
    const [cls, school, users] = [c.Class, s.School, byId(u.Users)];
    const tutors = (cls?.ClassTutors ?? []).filter((t) => users.has(String(t.Id))).map((t) => person(users.get(String(t.Id))));
    return [
      ['Klasa', [cls?.Number, cls?.Symbol].filter((x) => x != null).join('')],
      ['Wychowawca', tutors.join(', ')],
      ['Szkoła', school?.Name],
      ['Adres', [[school?.Street, school?.BuildingNumber].filter(Boolean).join(' '), school?.Town].filter(Boolean).join(', ')],
    ].filter(([, v]) => v);
  }

  const info = resource(() => about(login));
</script>

{#if info.data?.length}
  <ul class="card totals">
    {#each info.data as [label, value] (label)}
      <li><span>{label}</span><span class="muted">{value}</span></li>
    {/each}
  </ul>
{/if}

<Async r={list} empty="Brak przypisanych nauczycieli.">
  {#snippet children(items)}
    <ul class="card totals">
      {#each items as s (s.name)}
        <li><span>{s.name}</span><span class="muted">{s.teachers}</span></li>
      {/each}
    </ul>
  {/snippet}
</Async>
