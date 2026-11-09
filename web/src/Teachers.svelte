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
</script>

<Async r={list} empty="Brak przypisanych nauczycieli.">
  {#snippet children(items)}
    <ul class="card totals">
      {#each items as s (s.name)}
        <li><span>{s.name}</span><span class="muted">{s.teachers}</span></li>
      {/each}
    </ul>
  {/snippet}
</Async>
