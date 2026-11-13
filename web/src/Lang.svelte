<script>
  import { LANGS, lang, setLang } from './i18n.js';

  /** The language switch of Login and Settings. The caller names the group (aria-label or aria-labelledby). */
  let props = $props();
</script>

<div class="segmented filter" role="group" {...props}>
  {#each Object.entries(LANGS) as [v, name] (v)}
    <button aria-pressed={lang === v} lang={v} onclick={() => lang !== v && setLang(v)}>{name}</button>
  {/each}
</div>
