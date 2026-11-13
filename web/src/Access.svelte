<script>
  import { api, post, resource, message } from './api.svelte.js';
  import { fmtUnix, mail } from './util.js';
  import Async from './Async.svelte';
  import Icon from './Icon.svelte';
  import { t } from './i18n.js';

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
    if (!confirm(t('Odebrać dostęp adresowi {address}? Ta osoba zostanie wylogowana.', { address }))) return;
    change(() => api(`admin/emails/${encodeURIComponent(address)}`, { method: 'DELETE' }));
  }
</script>

<form class="card compose" onsubmit={add}>
  <label>
    {t('E-mail konta LIBRUS')}
    <input type="email" name="email" placeholder={t('uczen@przyklad.pl')} required maxlength="254" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="done" bind:value={email} />
  </label>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button class="primary" disabled={busy || !email.trim()}><Icon name="plus" size={20} />{t('Daj dostęp')}</button>
</form>

<Async r={list}>
  {#snippet children(d)}
    <section class="card">
      <h2>{t('Dodane adresy')} <span class="muted count">{d.emails.length}</span></h2>
      {#if !d.emails.length}
        <p class="muted">{t('Nikt jeszcze nie dostał dostępu.')}</p>
      {:else}
        <ul class="entries access">
          {#each d.emails as a (a.email)}
            <li>
              <span class="grow">
                {mail(a.email)}
                <small class="muted">{a.active ? t('zalogowany') : t('niezalogowany')} · {t('dodany {when}', { when: fmtUnix(a.added) })}</small>
                <!-- Why the last sign-in failed, as the person saw it; gone once one works. -->
                {#if a.failed}<small class="error">{t('Nieudane logowanie {when}:', { when: fmtUnix(a.failed.at) })} {message({ message: a.failed.reason, cause: a.failed.said })}</small>{/if}
              </span>
              <button class="icon-btn" disabled={busy} onclick={() => remove(a.email)} aria-label={t('Odbierz dostęp: {email}', { email: a.email })} title={t('Odbierz dostęp')}>
                <Icon name="close" />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
    <section class="card">
      <h2>{t('Z konfiguracji serwera')}</h2>
      <ul class="entries access">
        {#each d.fixed as a (a)}
          <li><span class="grow">{mail(a)}</span></li>
        {/each}
      </ul>
      <p class="muted">{t('Zmienne')} <code translate="no">ADMIN_EMAILS</code> {t('i')} <code translate="no">ALLOWED_EMAILS</code>. {t('Zmiana wymaga restartu serwera.')}</p>
      {#if commit}<p class="muted">{t('Serwer zbudowany z commita')} <code translate="no">{commit}</code>.</p>{/if}
    </section>
  {/snippet}
</Async>
