<script>
  import { install, byHand, android } from './api.svelte.js';
  import Icon from './Icon.svelte';

  /**
   * Installs the app where the browser lets a page ask (Chromium), and says how where it does not (iOS). On Android it
   * also points to Chrome: other browsers there may install the app badly or not at all.
   * Renders nothing once the app runs installed. `row` styles the button as a sidebar row.
   */
  let { row = false } = $props();

  async function ask() {
    const event = install.event;
    event.prompt();
    await event.userChoice;
    // One event answers one question, whatever the answer was.
    install.event = null;
  }
</script>

{#if install.event}
  <button class={row ? 'nav-row' : 'secondary wide'} onclick={ask}><Icon name="download" size={row ? 18 : 20} />Zainstaluj aplikację</button>
{/if}
{#if byHand && !row}
  <p class="center muted">Aby zainstalować aplikację, dotknij Udostępnij, a potem „Do ekranu początkowego”.</p>
{:else if android && !row}
  <p class="center muted">
    Nie wszystkie przeglądarki na Androidzie dobrze obsługują aplikacje instalowane ze strony. Najlepiej zainstaluj Dziennik
    z&nbsp;Google Chrome.
  </p>
{/if}
