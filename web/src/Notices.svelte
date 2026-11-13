<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDate, person, plain } from './util.js';
  import Async from './Async.svelte';
  import Rich from './Rich.svelte';
  import { t } from './i18n.js';

  let { login } = $props();

  async function load(login) {
    const [n, u] = await Promise.all([synergia(login, 'SchoolNotices'), lookup(login, 'Users')]);
    const users = byId(u.Users);
    return (n.SchoolNotices ?? [])
      .map((x) => ({
        id: x.Id,
        title: plain(x.Subject) || t('Ogłoszenie'),
        text: plain(x.Content),
        date: x.StartDate ?? x.CreationDate ?? '',
        until: x.EndDate,
        who: x.AddedBy?.Id ? person(users.get(String(x.AddedBy.Id))) : '',
      }))
      .sort((p, q) => q.date.localeCompare(p.date));
  }

  const list = resource(() => load(login), () => `notices/${login}`);
</script>

<Async r={list} empty={t('Brak ogłoszeń.')}>
  {#snippet children(items)}
    <div class="card stack">
      {#each items as n (n.id)}
        <details>
          <summary>
            <strong>{n.title}</strong>
            <small class="muted">{[fmtDate(n.date), n.who].filter(Boolean).join(' · ')}</small>
          </summary>
          <Rich text={n.text} />
          {#if n.until}<p class="muted">{t('Ważne do {date}', { date: fmtDate(n.until) })}</p>{/if}
        </details>
      {/each}
    </div>
  {/snippet}
</Async>
