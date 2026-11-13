<script>
  import { clock } from './api.svelte.js';
  import Icon from './Icon.svelte';
  import { t } from './i18n.js';

  /** Renders the loading, error and empty states of a `resource()`; `children` gets the data. */
  let { r, empty = t('Brak danych.'), children } = $props();
</script>

{#snippet again()}
  <button class="link" onclick={() => clock.tick++}><Icon name="refresh" size={18} />{t('Spróbuj ponownie')}</button>
{/snippet}

{#if r.error}
  <div class="error" role="alert">
    <p>{r.error}</p>
    {#if r.retry}{@render again()}{/if}
  </div>
{:else if r.data === undefined}
  <p class="center muted" role="status">{t('Ładowanie…')}</p>
{:else}
  {#if r.failed}
    <div class="note-line muted" role="status">
      <p>{t('Nie udało się odświeżyć, widać ostatnie dane.')} {r.failed}</p>
      {#if r.retry}{@render again()}{/if}
    </div>
  {/if}
  {#if Array.isArray(r.data) && !r.data.length}
    <p class="center muted">{empty}</p>
  {:else}
    {@render children(r.data)}
  {/if}
{/if}
