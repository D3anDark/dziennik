<script>
  /** Renders the loading, error and empty states of a `resource()`; `children` gets the data. */
  let { r, empty = 'Brak danych.', children } = $props();
</script>

{#if r.error}
  <p class="error" role="alert">{r.error}</p>
{:else if r.data === undefined}
  <p class="center muted">Ładowanie…</p>
{:else if Array.isArray(r.data) && !r.data.length}
  <p class="center muted">{empty}</p>
{:else}
  {@render children(r.data)}
{/if}
