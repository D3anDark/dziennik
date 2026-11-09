<script>
  import { synergia, resource, byId, message, refreshUnread } from './api.svelte.js';
  import { fmtUnix, person, plain, initials } from './util.js';
  import Async from './Async.svelte';
  import Rich from './Rich.svelte';
  import Icon from './Icon.svelte';
  import Compose from './Compose.svelte';

  /** `arg` from the route: `<id>` opens a message, `nowa` writes one, `nowa/<id>` answers <id>. */
  let { login, arg } = $props();

  const LIMIT = 300;
  // ponytail: stops after 1200 messages; page backwards from the newest if an account ever has more.
  const MAX_PAGES = 4;
  const QUERY = 'alternativeBody=true&changeNewLine=1';
  const flag = (v) => Boolean(Number(v));

  /** Sender and receiver names come from Messages/User, which takes at most 10 ids per call. */
  async function people(login, ids) {
    const list = [...new Set(ids.map(String))].filter((id) => id && id !== '0');
    const chunks = [];
    for (let i = 0; i < list.length; i += 10) chunks.push(list.slice(i, i + 10).join(','));
    const res = await Promise.all(
      chunks.map((c) => synergia(login, `Messages/User/${c}`).then((r) => r.Users ?? [r.User], () => [])),
    );
    return byId(res.flat().filter(Boolean));
  }

  async function loadList(login) {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await synergia(login, `Messages?${QUERY}&afterId=1&limit=${LIMIT}&getAllTypes=1&page=${page}`);
      all.push(...(r.Messages ?? []));
      if ((r.Messages ?? []).length < LIMIT) break;
    }
    const live = all.filter((m) => !flag(m.inTrash));
    const users = await people(login, live.flatMap((m) => [m.Sender?.Id, ...(m.Receiver ?? []).map((x) => x.Id)]));
    return live
      .map((m) => {
        const sent = flag(m.inSended);
        return {
          id: m.Id,
          title: plain(m.Subject) || '(bez tematu)',
          who: sent
            ? (m.Receiver ?? []).map((x) => person(users.get(String(x.Id)))).join(', ')
            : person(users.get(String(m.Sender?.Id))),
          date: m.SendDate,
          sent,
          unread: !sent && String(m.ReadDates?.[0]?.ReadDate) === '0',
        };
      })
      .sort((p, q) => Number(q.date) - Number(p.date));
  }

  async function loadOne(login, id) {
    // Opening a message through the API marks it read.
    const m = (await synergia(login, `Messages/${id}?${QUERY}`)).Message;
    if (!m) throw new Error('http_404');
    const users = await people(login, [m.Sender?.Id, ...(m.Receivers ?? []).map((x) => x.Id)]);
    refreshUnread(login);
    return {
      title: plain(m.Subject) || '(bez tematu)',
      from: person(users.get(String(m.Sender?.Id))),
      to: (m.Receivers ?? []).map((x) => person(users.get(String(x.Id)))).join(', '),
      date: m.SendDate,
      body: plain(m.Body),
      files: flag(m.AddedFiles) || (m.MessageFiles ?? []).length > 0,
    };
  }

  const route = $derived(/^(?:(\d+)|nowa(?:\/(\d+))?)$/.exec(arg ?? ''));
  const id = $derived(route?.[1] ?? route?.[2] ?? null);
  const composing = $derived(Boolean(route) && route[1] === undefined);
  let folder = $state('in');
  let reload = $state(0);
  let sentId = $state(null);
  const data = resource(() => (reload, id ? loadOne(login, id) : composing ? Promise.resolve(null) : loadList(login)));

  let marking = $state(false);
  let markError = $state('');

  /** Synergia has no mark-read call: fetching a message is what marks it, so read each unread one, 4 at a time. */
  async function markAll(list) {
    marking = true;
    markError = '';
    const queue = list.filter((m) => m.unread).map((m) => m.id);
    const worker = async () => {
      while (queue.length) await synergia(login, `Messages/${queue.pop()}?${QUERY}`);
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    } catch (e) {
      markError = message(e);
    }
    marking = false;
    refreshUnread(login);
    reload++;
  }

  function sent(newId) {
    sentId = newId ? String(newId) : null;
    folder = 'out';
    location.hash = newId ? `#/wiadomosci/${newId}` : '#/wiadomosci';
  }
</script>

{#if composing}
  <Async r={data}>
    {#snippet children(original)}
      <Compose {login} {original} replyId={id} onsent={sent} />
    {/snippet}
  </Async>
{:else if id}
  <p><a class="back" href="#/wiadomosci"><Icon name="left" size={18} />Wróć do listy</a></p>
  {#if sentId === id}<p class="toast" role="status">Wiadomość wysłana.</p>{/if}
  <Async r={data}>
    {#snippet children(m)}
      <article class="card message">
        <h2>{m.title}</h2>
        <div class="meta">
          <span class="avatar small" aria-hidden="true">{initials(m.from)}</span>
          <p>
            Od: <strong>{m.from}</strong><br />
            <span class="muted">Do: {m.to}<br />{fmtUnix(m.date)}</span>
          </p>
        </div>
        <Rich text={m.body} />
        {#if m.files}
          <p class="note-line muted"><Icon name="paperclip" size={18} />Wiadomość ma załączniki. Pobierzesz je w aplikacji lub na stronie Librusa.</p>
        {/if}
      </article>
      <a class="button" href="#/wiadomosci/nowa/{id}"><Icon name="reply" size={20} />Odpowiedz</a>
    {/snippet}
  </Async>
{:else}
  <div class="toolbar">
    <div class="segmented" role="group" aria-label="Folder">
      <button aria-pressed={folder === 'in'} onclick={() => (folder = 'in')}>Odebrane</button>
      <button aria-pressed={folder === 'out'} onclick={() => (folder = 'out')}>Wysłane</button>
    </div>
    <a class="button primary" href="#/wiadomosci/nowa"><Icon name="pencil" size={20} />Napisz</a>
  </div>
  <Async r={data} empty="Brak wiadomości.">
    {#snippet children(list)}
      {@const shown = list.filter((m) => m.sent === (folder === 'out'))}
      {#if folder === 'in' && shown.some((m) => m.unread)}
        <button class="link" disabled={marking} onclick={() => markAll(shown)}>
          {marking ? 'Oznaczanie…' : 'Oznacz wszystkie jako przeczytane'}
        </button>
      {/if}
      {#if markError}<p class="error" role="alert">{markError}</p>{/if}
      {#if !shown.length}
        <p class="center muted">Brak wiadomości.</p>
      {:else}
        <ul class="card list messages">
          {#each shown as m (m.id)}
            <li class:unread={m.unread}>
              <a href="#/wiadomosci/{m.id}">
                <span class="avatar small" aria-hidden="true">{initials(m.who)}</span>
                <span class="grow">
                  <span class="subject">{m.title}</span>
                  <small class="muted">{folder === 'out' ? 'Do: ' : ''}{m.who}, {fmtUnix(m.date)}</small>
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    {/snippet}
  </Async>
{/if}
