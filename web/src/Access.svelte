<script>
  import { api, post, resource, message } from './api.svelte.js';
  import { fmtUnix, mail } from './util.js';
  import Async from './Async.svelte';
  import Icon from './Icon.svelte';

  /** Admin only: the addresses allowed to sign in. The server checks the role on every call. */
  let email = $state('');
  let busy = $state(false);
  let error = $state('');
  const list = resource(() => api('admin/emails'));
  /** The commit the server was built from: what to compare with GitHub when a deployment is in doubt. */
  let commit = $state('');
  api('about').then(
    (b) => (commit = String(b?.commit ?? '').slice(0, 7)),
    () => {},
  );

  /** Every change answers with the list as it now is. */
  async function change(request) {
    busy = true;
    error = '';
    try {
      list.data = await request();
      return true;
    } catch (e) {
      error = message(e);
      return false;
    } finally {
      busy = false;
    }
  }

  async function add(e) {
    e.preventDefault();
    if (await change(() => post('admin/emails', { email }))) email = '';
  }

  function remove(address) {
    if (!confirm(`Odebrać dostęp adresowi ${address}? Ta osoba zostanie wylogowana.`)) return;
    change(() => api(`admin/emails/${encodeURIComponent(address)}`, { method: 'DELETE' }));
  }
</script>

<form class="card compose" onsubmit={add}>
  <label>
    E-mail konta LIBRUS
    <input type="email" name="email" placeholder="uczen@przyklad.pl" required maxlength="254" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="done" bind:value={email} />
  </label>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button class="primary" disabled={busy || !email.trim()}><Icon name="plus" size={20} />Daj dostęp</button>
</form>

<Async r={list}>
  {#snippet children(d)}
    <section class="card">
      <h2>Dodane adresy <span class="muted count">{d.emails.length}</span></h2>
      {#if !d.emails.length}
        <p class="muted">Nikt jeszcze nie dostał dostępu.</p>
      {:else}
        <ul class="entries access">
          {#each d.emails as a (a.email)}
            <li>
              <span class="grow">
                {mail(a.email)}
                <small class="muted">{a.active ? 'zalogowany' : 'niezalogowany'} · dodany {fmtUnix(a.added)}</small>
                <!-- Why the last sign-in failed, as the person saw it; gone once one works. -->
                {#if a.failed}<small class="error">Nieudane logowanie {fmtUnix(a.failed.at)}: {message({ message: a.failed.reason, cause: a.failed.said })}</small>{/if}
              </span>
              <button class="icon-btn" disabled={busy} onclick={() => remove(a.email)} aria-label="Odbierz dostęp: {a.email}" title="Odbierz dostęp">
                <Icon name="close" />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
    <section class="card">
      <h2>Z konfiguracji serwera</h2>
      <ul class="entries access">
        {#each d.fixed as a (a)}
          <li><span class="grow">{mail(a)}</span></li>
        {/each}
      </ul>
      <p class="muted">Zmienne <code translate="no">ADMIN_EMAILS</code> i <code translate="no">ALLOWED_EMAILS</code>. Zmiana wymaga restartu serwera.</p>
      {#if commit}<p class="muted">Serwer zbudowany z commita <code translate="no">{commit}</code>.</p>{/if}
    </section>
  {/snippet}
</Async>
