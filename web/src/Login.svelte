<script>
  import { post, session, message, clearApiCache } from './api.svelte.js';
  import Icon from './Icon.svelte';

  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');

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
  <span class="brand" aria-hidden="true"><Icon name="book" size={28} /></span>
  <h1>Dziennik</h1>
  <p class="muted">Zaloguj się kontem LIBRUS (e-mail i hasło z portal.librus.pl).</p>
  <label>
    E-mail
    <input type="email" name="email" autocomplete="username" autocapitalize="none" spellcheck="false" enterkeyhint="next" required bind:value={email} />
  </label>
  <label>
    Hasło
    <input type="password" name="password" autocomplete="current-password" enterkeyhint="go" required bind:value={password} />
  </label>
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  <button class="primary" disabled={busy}>{busy ? 'Logowanie…' : 'Zaloguj'}</button>
</form>
