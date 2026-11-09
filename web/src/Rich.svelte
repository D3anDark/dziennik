<script>
  import { linkParts } from './util.js';

  /** Plain text with http(s) links made clickable. */
  let { text } = $props();
</script>

<p class="rich">
  {#each linkParts(text ?? '') as part, i (i)}{#if i % 2}<a href={part} target="_blank" rel="noopener noreferrer">{part}</a>{:else}{part}{/if}{/each}
</p>
