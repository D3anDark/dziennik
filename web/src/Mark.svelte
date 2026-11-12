<script>
  /**
   * A grade as its chip shows it: long text grades as school records shorten them, the full word kept in `title`.
   * `was`: the grades it improves, oldest first; the last of them stands struck out before it, as a replaced subject
   * does in the plan, and reads out as "1, poprawiona na 4".
   */
  let { value, was = null } = $props();
  const SHORT = { zwolniony: 'zw', nieklasyfikowany: 'nkl' };
  const short = $derived(SHORT[String(value).toLowerCase()]);
</script>

{#if was?.length}<s class="was">{was.at(-1).value}</s><span class="sr">, poprawiona na{' '}</span>{/if}{#if short}<abbr title={value}>{short}</abbr>{:else}{value}{/if}
