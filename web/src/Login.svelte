<script>
  import { post, session, message, clearApiCache, DEMO } from './api.svelte.js';
  import Icon from './Icon.svelte';
  import Privacy from './Privacy.svelte';
  import Lang from './Lang.svelte';
  import { t } from './i18n.js';

  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  /** Typed on a phone keyboard, a password is easy to get wrong unseen. */
  let shown = $state(false);
  let privacy = $state(false);

  async function submit(e) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      const me = await post('login', { email, password });
      await clearApiCache();
      password = '';
      session.me = me;
    } catch (err) {
      error = message(err);
    } finally {
      busy = false;
    }
  }
</script>

<form class="login card" onsubmit={submit}>
  <h1>Dziennik</h1>
  <Lang aria-label="Język · Language · Мова" />
  <p class="muted">{t('Zaloguj się kontem LIBRUS (e-mail i hasło z portal.librus.pl).')}</p>
  <p class="muted">{t('Login z\u00a0cyfr, otrzymany w\u00a0szkole, tu nie zadziała: najpierw dodaj to konto do swojego konta LIBRUS.')}</p>
  {#if DEMO}<p class="muted">{t('Wersja demonstracyjna: zadziała dowolny e-mail i\u00a0hasło.')}</p>{/if}
  <label>
    {t('E-mail')}
    <input type="email" name="email" autocomplete="username" autocapitalize="none" spellcheck="false" enterkeyhint="next" required bind:value={email} />
  </label>
  <label>
    {t('Hasło')}
    <span class="reveal">
      <input type={shown ? 'text' : 'password'} name="password" autocomplete="current-password" enterkeyhint="go" spellcheck="false" autocapitalize="none" required bind:value={password} />
      <button type="button" class="icon-btn" aria-pressed={shown} aria-label={t('Pokaż hasło')} title={t('Pokaż hasło')} onclick={() => (shown = !shown)}>
        <Icon name={shown ? 'eye-off' : 'eye'} size={20} />
      </button>
    </span>
  </label>
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  <button class="primary" disabled={busy}>{busy ? t('Logowanie…') : t('Zaloguj')}</button>
  <p class="byline">{t('Aplikacja nieoficjalna, niezwiązana z firmą Librus. Hasło przechodzi przez serwer aplikacji do Librusa i nie jest zapisywane.')}</p>
  <details class="byline" bind:open={privacy}>
    <summary>{t('Prywatność i\u00a0RODO')}</summary>
    {#if privacy}<Privacy />{/if}
  </details>
</form>
