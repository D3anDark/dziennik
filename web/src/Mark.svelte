<script>
  /** A grade as its chip shows it: long text grades as school records shorten them, the full word kept in `title`. */
  let { value } = $props();
  const SHORT = { zwolniony: 'zw', nieklasyfikowany: 'nkl' };
  const short = $derived(SHORT[String(value).toLowerCase()]);
</script>

{#if short}<abbr title={value}>{short}</abbr>{:else}{value}{/if}
