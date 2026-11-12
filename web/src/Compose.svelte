<script>
  import { untrack } from 'svelte';
  import { synergia, lookup, write, message, resource, drafts } from './api.svelte.js';
  import { person, short } from './util.js';
  import Async from './Async.svelte';
  import Icon from './Icon.svelte';
  import { viaWeb, useWeb, groups as webGroups, send as webSend } from './webmail.js';

  /** `original` is the message being answered (from Messages' loadOne), or null for a new message. */
  let { login, original = null, replyId = null, onsent } = $props();

  /**
   * Recipient groups: one request per group, parents and guardians left out,
   * nested subgroups flattened into their own sections. A group that fails to load is skipped.
   */
  async function groups(login) {
    const list = (await synergia(login, 'Messages/ReceiversGroup')).ReceiversGroup ?? [];
    const loaded = await Promise.all(
      list
        .filter((g) => g.Id !== 'parents' && g.Id !== 'guardians')
        .map((g) => synergia(login, `Messages/ReceiversGroup/${encodeURIComponent(g.Id)}`).then((r) => r.ReceiversGroup?.[0], () => null)),
    );
    // Screenshot mode (util.js): a label does not say which of its words is the surname; the school's list of people
    // does. A name not on that list is left as initials.
    const words = (name) => String(name).toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
    const known = short ? new Map(((await lookup(login, 'Users').catch(() => ({}))).Users ?? []).map((u) => [words(`${u.FirstName} ${u.LastName}`), u])) : null;
    const brief = (p) => (known ? { ...p, Label: known.has(words(p.Label)) ? person(known.get(words(p.Label))) : String(p.Label).replace(/(\p{L})\p{L}*/gu, '$1.') } : p);
    return loaded.filter(Boolean).flatMap((g) =>
      g.ReceiversSubGroup
        ? g.ReceiversSubGroup.map((s) => ({ label: `${g.Label}: ${s.Label}`, people: (s.Receivers ?? []).map(brief) }))
        : [{ label: g.Label, people: (g.Receivers ?? []).map(brief) }],
    ).filter((s) => s.people.length);
  }

  /** An account the API refuses writes through the Synergia website (webmail.js); its message ids look like "5-123". */
  const onWeb = () => viaWeb(login) || String(replyId ?? '').includes('-');

  const book = resource(() => {
    if (replyId) return Promise.resolve([]);
    if (onWeb()) return webGroups(login);
    return groups(login).catch((e) => {
      if (e.message !== 'premium') throw e;
      useWeb(login);
      return webGroups(login);
    });
  }, () => (replyId ? undefined : `book/${login}`));

  // The parent remounts this form per message, so the starting subject is read once.
  let subject = $state(untrack(() => (original ? `Re: ${original.title}` : '')));
  let body = $state('');
  let picked = $state([]);
  let filter = $state('');
  let busy = $state(false);
  let error = $state('');
  let bodyField;

  /** Enter on a phone's keyboard would submit the whole form from any field; here only the button sends. */
  const enter = (then) => (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    then(e.currentTarget);
  };

  // Closing the tab or reloading with a message half written asks first, and a new build waits (main.js).
  $effect(() => {
    if (!body.trim()) return;
    const warn = (e) => e.preventDefault();
    addEventListener('beforeunload', warn);
    untrack(() => drafts.open++);
    return () => {
      removeEventListener('beforeunload', warn);
      untrack(() => drafts.open--);
    };
  });

  const names = $derived(new Map((book.data ?? []).flatMap((s) => s.people.map((p) => [String(p.Id), p.Label]))));
  const query = $derived(filter.trim().toLowerCase());

  function toggle(id, on) {
    picked = on ? [...picked, id] : picked.filter((x) => x !== id);
  }

  async function send(e) {
    e.preventDefault();
    error = '';
    if (!replyId && !picked.length) return (error = 'Wybierz odbiorcę wiadomości.');
    if (!subject.trim() || !body.trim()) return (error = 'Uzupełnij temat i treść.');
    busy = true;
    try {
      const msg = replyId
        ? { subject, body, originalMessageId: replyId }
        : { subject, body, receivers: picked };
      onsent(onWeb() ? await webSend(login, msg) : (await write(login, 'Messages', msg))?.Message?.Id);
    } catch (err) {
      error = err.cause ?? message(err);
    } finally {
      busy = false;
    }
  }
</script>

<p><a class="back" href={replyId ? `#/wiadomosci/${replyId}` : '#/wiadomosci'}><Icon name="left" size={18} />{replyId ? 'Wiadomość' : 'Wiadomości'}</a></p>
<h1 class="title" tabindex="-1">{replyId ? 'Odpowiedź' : 'Nowa wiadomość'}</h1>

<form class="card compose" onsubmit={send}>
  {#if replyId}
    <p class="muted">Do: {original?.from ?? '…'}</p>
  {:else}
    <fieldset class="receivers">
      <legend>Do</legend>
      {#if picked.length}
        <ul class="chips picked">
          {#each picked as id (id)}
            <li>
              <button type="button" class="pill" onclick={() => toggle(id, false)} aria-label="Usuń {names.get(id)}">
                {names.get(id)}<Icon name="close" size={16} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <Async r={book} empty="Brak dostępnych odbiorców.">
        {#snippet children(sections)}
          <input type="search" name="receiver" placeholder="Szukaj odbiorcy…" aria-label="Szukaj odbiorcy" autocomplete="off" enterkeyhint="search" bind:value={filter} onkeydown={enter((field) => field.blur())} />
          {#each sections as s (s.label)}
            {@const shown = query ? s.people.filter((p) => p.Label.toLowerCase().includes(query)) : s.people}
            {@const chosen = shown.filter((p) => picked.includes(String(p.Id))).length}
            {#if shown.length}
              <details open={query.length > 1}>
                <summary>{s.label} <span class="muted">{chosen} z {shown.length}</span></summary>
                {#each shown as p (p.Id)}
                  <label class="check">
                    <input type="checkbox" checked={picked.includes(String(p.Id))} onchange={(e) => toggle(String(p.Id), e.currentTarget.checked)} />
                    {p.Label}
                  </label>
                {/each}
              </details>
            {/if}
          {/each}
        {/snippet}
      </Async>
    </fieldset>
  {/if}
  <label>
    Temat
    <input name="subject" autocomplete="off" enterkeyhint="next" required bind:value={subject} onkeydown={enter(() => bodyField.focus())} />
  </label>
  <label>
    Treść
    <textarea name="body" required rows="8" bind:value={body} bind:this={bodyField}></textarea>
  </label>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="dock">
    <button class="primary send" disabled={busy}>{busy ? 'Wysyłanie…' : 'Wyślij'}</button>
  </div>
</form>
