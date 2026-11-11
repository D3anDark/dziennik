<script>
  import { post, session, message, clearApiCache, DEMO } from './api.svelte.js';
  import Icon from './Icon.svelte';

  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  /** Typed on a phone keyboard, a password is easy to get wrong unseen. */
  let shown = $state(false);

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
  <p class="muted">Zaloguj się kontem LIBRUS (e-mail i hasło z portal.librus.pl).</p>
  {#if DEMO}<p class="muted">Wersja demonstracyjna: zadziała dowolny e-mail i&nbsp;hasło.</p>{/if}
  <label>
    E-mail
    <input type="email" name="email" autocomplete="username" autocapitalize="none" spellcheck="false" enterkeyhint="next" required bind:value={email} />
  </label>
  <label>
    Hasło
    <span class="reveal">
      <input type={shown ? 'text' : 'password'} name="password" autocomplete="current-password" enterkeyhint="go" spellcheck="false" autocapitalize="none" required bind:value={password} />
      <button type="button" class="icon-btn" aria-pressed={shown} aria-label="Pokaż hasło" title="Pokaż hasło" onclick={() => (shown = !shown)}>
        <Icon name={shown ? 'eye-off' : 'eye'} size={20} />
      </button>
    </span>
  </label>
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  <button class="primary" disabled={busy}>{busy ? 'Logowanie…' : 'Zaloguj'}</button>
  <p class="byline">Aplikacja nieoficjalna, niezwiązana z firmą Librus. Hasło przechodzi przez serwer aplikacji do Librusa i nie jest zapisywane.</p>
</form>
