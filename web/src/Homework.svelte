<script>
  import { synergia, lookup, resource, byId, write, message } from './api.svelte.js';
  import { fmtDate, person, plain, today } from './util.js';
  import Async from './Async.svelte';
  import Rich from './Rich.svelte';
  import Icon from './Icon.svelte';
  import Files from './Files.svelte';
  import { t } from './i18n.js';

  let { login } = $props();
  const todayIso = today();

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
        topic: plain(x.Topic) || t('Zadanie'),
        text: plain(x.Text),
        given: x.Date,
        due: x.DueDate,
        subject: subjects.get(String(lessons.get(String(x.Lesson?.Id))?.Subject?.Id))?.Name ?? '',
        teacher: x.Teacher?.Id ? person(users.get(String(x.Teacher.Id))) : '',
        read: (x.StudentsWhoRead ?? []).length > 0,
        done: (x.StudentsWhoMarkedAsDone ?? []).length > 0,
        // The field name is misspelled by Librus.
        files: x.HomeworkAssigmentFiles ?? [],
      }))
      // What is still to do comes first, the nearest due date on top; then the rest, newest first, done last.
      .sort((p, q) => rank(p) - rank(q) || (rank(p) ? (q.due ?? '').localeCompare(p.due ?? '') : (p.due ?? '').localeCompare(q.due ?? '')));
  }

  function rank(h) {
    return h.done ? 2 : (h.due ?? '') >= todayIso ? 0 : 1;
  }

  const list = resource(() => load(login), () => `homework/${login}`);
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

<Async r={list} empty={t('Brak zadań domowych.')}>
  {#snippet children(items)}
    <div class="card stack">
      {#each items as h (h.id)}
        <details class:unread={!h.read} class:done={h.done} ontoggle={(e) => opened(h, e)}>
          <summary>
            <strong>{h.topic}</strong>
            {#if h.done}<span class="tag plain">{t('wykonane')}</span>{:else if h.due && h.due < todayIso}<span class="tag">{t('po terminie')}</span>{/if}
            <small class="muted">
              <!-- Each part kept whole, and a wrapped line starts with its "·", none left hanging at an end. -->
              {[h.subject, h.due && t('termin {date}', { date: fmtDate(h.due) }), h.given && t('zadane {date}', { date: fmtDate(h.given) }), h.teacher]
                .filter(Boolean)
                .map((p) => p.replaceAll(' ', '\u00a0'))
                .join(' ·\u00a0')}
            </small>
          </summary>
          {#if h.text}<Rich text={h.text} />{/if}
          {#if h.files.length}<Files link={(f) => synergia(login, `HomeWorkAssignments/Attachment/${h.id}-${f.Id}`)} files={h.files} />{/if}
          {#if !h.done}
            <button class="secondary" disabled={busy === h.id} onclick={() => markDone(h)}>
              <Icon name="done" size={20} />{busy === h.id ? t('Zapisywanie…') : t('Oznacz jako wykonane')}
            </button>
          {/if}
          {#if error.id === h.id}<p class="error" role="alert">{error.text}</p>{/if}
        </details>
      {/each}
    </div>
  {/snippet}
</Async>
