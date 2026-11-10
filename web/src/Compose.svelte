<script>
  import { untrack } from 'svelte';
  import { synergia, write, message, resource } from './api.svelte.js';
  import Async from './Async.svelte';
  import Icon from './Icon.svelte';

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
    return loaded.filter(Boolean).flatMap((g) =>
      g.ReceiversSubGroup
        ? g.ReceiversSubGroup.map((s) => ({ label: `${g.Label}: ${s.Label}`, people: s.Receivers ?? [] }))
        : [{ label: g.Label, people: g.Receivers ?? [] }],
    ).filter((s) => s.people.length);
  }

  const book = resource(() => (replyId ? Promise.resolve([]) : groups(login)));

  // The parent remounts this form per message, so the starting subject is read once.
  let subject = $state(untrack(() => (original ? `Re: ${original.title}` : '')));
  let body = $state('');
  let picked = $state([]);
  let filter = $state('');
  let busy = $state(false);
  let error = $state('');

  // Closing the tab or reloading with a message half written asks first.
  $effect(() => {
    if (!body.trim()) return;
    const warn = (e) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
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
      const r = await write(login, 'Messages', msg);
      onsent(r?.Message?.Id);
    } catch (err) {
      error = err.cause ?? message(err);
    } finally {
      busy = false;
    }
  }
</script>

<p><a class="back" href={replyId ? `#/wiadomosci/${replyId}` : '#/wiadomosci'}><Icon name="left" size={18} />Anuluj</a></p>

<form class="card compose" onsubmit={send}>
  <h2>{replyId ? 'Odpowiedź' : 'Nowa wiadomość'}</h2>
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
          <input type="search" name="receiver" placeholder="Szukaj odbiorcy…" aria-label="Szukaj odbiorcy" autocomplete="off" enterkeyhint="search" bind:value={filter} />
          {#each sections as s (s.label)}
            {@const shown = query ? s.people.filter((p) => p.Label.toLowerCase().includes(query)) : s.people}
            {#if shown.length}
              <details open={query.length > 1}>
                <summary>{s.label} <span class="muted">{shown.length}</span></summary>
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
    <input name="subject" autocomplete="off" enterkeyhint="next" required bind:value={subject} />
  </label>
  <label>
    Treść
    <textarea name="body" required rows="8" bind:value={body}></textarea>
  </label>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button class="primary" disabled={busy}>{busy ? 'Wysyłanie…' : 'Wyślij'}</button>
</form>
