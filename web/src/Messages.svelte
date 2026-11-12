<script>
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { synergia, resource, byId, message } from './api.svelte.js';
  import { viaWeb, useWeb, folder as webFolder, message as webMessage, fileLink, refreshUnread } from './webmail.js';
  import { fmtUnix, ago, person, plain, initials, plural } from './util.js';
  import Async from './Async.svelte';
  import Rich from './Rich.svelte';
  import Icon from './Icon.svelte';
  import Compose from './Compose.svelte';
  import Files from './Files.svelte';

  /** `arg` from the route: `<id>` opens a message, `nowa` writes one, `nowa/<id>` answers <id>. */
  let { login, arg } = $props();

  /**
   * An account without Mobilne Dodatki gets no messages from the API, so they are read from the Synergia website
   * (webmail.js): both folders, attachments and writing. Their ids carry the folder, like "5-123".
   */
  let onWeb = $state(untrack(() => viaWeb(login)));
  const fromWeb = (id) => String(id).includes('-');

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

  async function apiList(login) {
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

  /** The first refusal switches this student to the website; `onWeb` then runs the list again from there. */
  const loadList = (login) =>
    apiList(login).catch((e) => {
      if (e.message !== 'premium') throw e;
      useWeb(login);
      onWeb = true;
      return [];
    });

  /** Messages opened on this visit: the list remembered from before still has them unread until it reloads. */
  const opened = new SvelteSet();
  const unread = (m) => m.unread && !opened.has(String(m.id));

  async function loadOne(login, id) {
    const one = await (fromWeb(id) ? webMessage(login, id) : apiOne(login, id));
    opened.add(id);
    return one;
  }

  async function apiOne(login, id) {
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
      files: m.MessageFiles ?? [],
      // Flagged as having attachments, but the list did not come with the message.
      unlisted: flag(m.AddedFiles) && !m.MessageFiles?.length,
    };
  }

  const route = $derived(/^(?:((?:\d-)?\d+)|nowa(?:\/((?:\d-)?\d+))?)$/.exec(arg ?? ''));
  const id = $derived(route?.[1] ?? route?.[2] ?? null);
  const composing = $derived(Boolean(route) && route[1] === undefined);
  let folder = $state('in');
  let search = $state('');
  const query = $derived(search.trim().toLowerCase());
  let reload = $state(0);
  let sentId = $state(null);
  const data = resource(
    () => (reload, id ? loadOne(login, id) : composing ? Promise.resolve(null) : onWeb ? webFolder(login, folder) : loadList(login)),
    () => (id ? `message/${login}/${id}` : composing ? undefined : `messages/${login}/${onWeb ? folder : 'api'}`),
  );

  let marking = $state(false);
  let markError = $state('');

  /** Synergia has no mark-read call: fetching a message is what marks it, so read each unread one, 4 at a time. */
  async function markAll(list) {
    const queue = list.filter(unread).map((m) => m.id);
    // Asked first: a message once fetched stays read, and a school can see that it was opened.
    if (!confirm(`Oznaczyć wszystkie nieprzeczytane wiadomości (${queue.length}) jako przeczytane? Librus zapisze je jako otwarte i nie da się tego cofnąć.`)) return;
    marking = true;
    markError = '';
    const worker = async () => {
      while (queue.length) await (onWeb ? webMessage(login, queue.pop()) : synergia(login, `Messages/${queue.pop()}?${QUERY}`));
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
    // The form's history entry becomes the sent message, so going back does not open an empty form again.
    const from = history.state?.from;
    location.replace(newId ? `#/wiadomosci/${newId}` : '#/wiadomosci');
    history.replaceState({ from }, '');
  }
</script>

{#if composing}
  <Async r={data}>
    {#snippet children(original)}
      <Compose {login} {original} replyId={id} onsent={sent} />
    {/snippet}
  </Async>
{:else if id}
  <p><a class="back" href="#/wiadomosci"><Icon name="left" size={18} />Wiadomości</a></p>
  <!-- The subject names the view; until the message is in it is just a message. -->
  <h1 class="title" tabindex="-1">{(!Array.isArray(data.data) && data.data?.title) || 'Wiadomość'}</h1>
  {#if sentId === id}<p class="toast" role="status">Wiadomość wysłana.</p>{/if}
  <Async r={data}>
    {#snippet children(m)}
      <article class="card message">
        <div class="meta">
          <span class="avatar small" aria-hidden="true">{initials(m.from || m.to)}</span>
          <p>
            {#if m.from}Od: <strong>{m.from}</strong><br />{/if}
            <span class="muted">{#if m.to}Do: {m.to}<br />{/if}{fmtUnix(m.date)}</span>
          </p>
        </div>
        <Rich text={m.body} />
        {#if m.files.length}
          <Files link={(f) => (fromWeb(id) ? fileLink(login, id, f) : synergia(login, `Messages/Attachment/${id}-${f.Id}`))} files={m.files} />
        {:else if m.unlisted}
          <p class="note-line muted">
            <Icon name="paperclip" size={18} />
            <span>Wiadomość ma załączniki, ale Librus nie podaje ich listy. Pobierzesz je w oficjalnej aplikacji Librusa albo na <a href="https://synergia.librus.pl" target="_blank" rel="noopener">synergia.librus.pl</a>.</span>
          </p>
        {/if}
      </article>
      <!-- On the website only a received message (folder 5) has a reply form. -->
      {#if !fromWeb(id) || id.startsWith('5-')}<div class="dock"><a class="button wide primary" href="#/wiadomosci/nowa/{id}"><Icon name="reply" size={20} />Odpowiedz</a></div>{/if}
    {/snippet}
  </Async>
{:else}
  <div class="toolbar">
    <div class="segmented" role="group" aria-label="Folder">
      <button aria-pressed={folder === 'in'} onclick={() => (folder = 'in')}>Odebrane</button>
      <button aria-pressed={folder === 'out'} onclick={() => (folder = 'out')}>Wysłane</button>
    </div>
    <a class="button primary" href="#/wiadomosci/nowa"><Icon name="pencil" size={20} /><span>Napisz</span></a>
  </div>
  <Async r={data} empty="Brak wiadomości.">
    {#snippet children(list)}
      {@const inFolder = list.filter((m) => m.sent === (folder === 'out'))}
      {@const shown = query ? inFolder.filter((m) => `${m.who} ${m.title}`.toLowerCase().includes(query)) : inFolder}
      {#if inFolder.length}
        <input class="search" type="search" placeholder="Szukaj nadawcy lub tematu…" aria-label="Szukaj w wiadomościach" autocomplete="off" enterkeyhint="search" bind:value={search} />
      {/if}
      {@const unreadCount = folder === 'in' ? inFolder.filter(unread).length : 0}
      {#if unreadCount}
        <!-- The list's own header: how many are new, and the one action on all of them. -->
        <div class="list-head">
          <span><strong class="new">{unreadCount}</strong> {plural(unreadCount, ['nieprzeczytana', 'nieprzeczytane', 'nieprzeczytanych'])}</span>
          <button class="link mark-all" disabled={marking} onclick={() => markAll(inFolder)}>
            <Icon name="check" size={16} />{marking ? 'Oznaczanie…' : 'Oznacz jako przeczytane'}
          </button>
        </div>
      {/if}
      {#if markError}<p class="error" role="alert">{markError}</p>{/if}
      {#if !shown.length}
        <p class="center muted" role="status">{query ? 'Brak wiadomości pasujących do wyszukiwania.' : 'Brak wiadomości.'}</p>
      {:else}
        <ul class="card list messages">
          {#each shown as m (m.id)}
            <li class:unread={unread(m)}>
              <a href="#/wiadomosci/{m.id}">
                <span class="grow">
                  <span class="who"><span>{folder === 'out' ? 'Do: ' : ''}{m.who}</span></span>
                  <small class="subject">{m.title}</small>
                </span>
                <time title={fmtUnix(m.date)}>{ago(m.date)}</time>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    {/snippet}
  </Async>
{/if}
