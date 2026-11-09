<script>
  import { synergia, lookup, resource, byId, write, message } from './api.svelte.js';
  import { fmtDate, person, plain, today } from './util.js';
  import Async from './Async.svelte';
  import Rich from './Rich.svelte';
  import Icon from './Icon.svelte';

  let { login } = $props();
  const t = today();

  async function load(login) {
    const [h, u, ls, s] = await Promise.all([
      synergia(login, 'HomeWorkAssignments'),
      lookup(login, 'Users'),
      lookup(login, 'Lessons'),
      lookup(login, 'Subjects'),
    ]);
    const [users, lessons, subjects] = [byId(u.Users), byId(ls.Lessons), byId(s.Subjects)];
    return (h.HomeWorkAssignments ?? [])
      .map((x) => ({
        id: x.Id,
        topic: plain(x.Topic) || 'Zadanie',
        text: plain(x.Text),
        given: x.Date,
        due: x.DueDate,
        subject: subjects.get(String(lessons.get(String(x.Lesson?.Id))?.Subject?.Id))?.Name ?? '',
        teacher: x.Teacher?.Id ? person(users.get(String(x.Teacher.Id))) : '',
        read: (x.StudentsWhoRead ?? []).length > 0,
        done: (x.StudentsWhoMarkedAsDone ?? []).length > 0,
      }))
      .sort((p, q) => (q.due ?? '').localeCompare(p.due ?? ''));
  }

  const list = resource(() => load(login));
  let busy = $state(null);
  let error = $state({ id: null, text: '' });

  /** Opening an assignment marks it read. Best effort: the next load shows the real state. */
  function opened(h, e) {
    if (!e.currentTarget.open || h.read) return;
    h.read = true;
    write(login, 'HomeWorkAssignments/MarkAsRead', { homework: h.id }).catch(() => (h.read = false));
  }

  async function markDone(h) {
    busy = h.id;
    error = { id: null, text: '' };
    try {
      await write(login, 'HomeWorkAssignments/MarkAsDone', { homework: h.id });
      h.done = true;
    } catch (e) {
      error = { id: h.id, text: e.cause ?? message(e) };
    } finally {
      busy = null;
    }
  }
</script>

<Async r={list} empty="Brak zadań domowych.">
  {#snippet children(items)}
    {#each items as h (h.id)}
      <details class="card" class:today={h.due >= t} class:unread={!h.read} class:done={h.done} ontoggle={(e) => opened(h, e)}>
        <summary>
          <strong>{h.topic}</strong>
          {#if h.done}<span class="tag ok"><Icon name="done" size={16} />wykonane</span>{/if}
          <small class="muted">
            {[h.subject, h.due && `termin ${fmtDate(h.due)}`].filter(Boolean).join(', ')}
          </small>
        </summary>
        <p class="muted">Zadane {fmtDate(h.given)}{#if h.teacher}, {h.teacher}{/if}</p>
        {#if h.text}<Rich text={h.text} />{/if}
        {#if !h.done}
          <button class="secondary" disabled={busy === h.id} onclick={() => markDone(h)}>
            <Icon name="done" size={20} />{busy === h.id ? 'Zapisywanie…' : 'Oznacz jako wykonane'}
          </button>
        {/if}
        {#if error.id === h.id}<p class="error" role="alert">{error.text}</p>{/if}
      </details>
    {/each}
  {/snippet}
</Async>
