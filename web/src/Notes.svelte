<script>
  import { synergia, lookup, resource, byId } from './api.svelte.js';
  import { fmtDate, person, plain } from './util.js';
  import Async from './Async.svelte';
  import Rich from './Rich.svelte';
  import { t } from './i18n.js';

  let { login } = $props();

  // Notes.Positive: 0 negative, 1 positive, 2 neutral.
  const TYPES = ['negatywna', 'pozytywna', 'neutralna'];
  const LABELS = { negatywna: t('negatywna'), pozytywna: t('pozytywna'), neutralna: t('neutralna') };

  async function load(login) {
    const [n, c, u] = await Promise.all([
      synergia(login, 'Notes'),
      lookup(login, 'Notes/Categories'),
      lookup(login, 'Users'),
    ]);
    const [cats, users] = [byId(c.Categories), byId(u.Users)];
    return (n.Notes ?? [])
      .map((x) => {
        const cat = cats.get(String(x.Category?.Id));
        return {
          id: x.Id,
          text: plain(x.Text),
          date: x.Date ?? '',
          type: TYPES[Number(x.Positive)] ?? '',
          category: cat?.Name ?? cat?.CategoryName ?? '',
          who: x.Teacher?.Id ? person(users.get(String(x.Teacher.Id))) : '',
        };
      })
      .sort((p, q) => q.date.localeCompare(p.date));
  }

  const list = resource(() => load(login), () => `notes/${login}`);
</script>

<Async r={list} empty={t('Brak uwag.')}>
  {#snippet children(items)}
    <div class="card stack">
      {#each items as n (n.id)}
        <article class="note {n.type}">
          <h2>{n.category || t('Uwaga')} {#if n.type}<span class="tag" class:plain={n.type !== 'negatywna'}>{LABELS[n.type]}</span>{/if}</h2>
          <p class="byline">{[fmtDate(n.date), n.who].filter(Boolean).join(' · ')}</p>
          <Rich text={n.text} />
        </article>
      {/each}
    </div>
  {/snippet}
</Async>
