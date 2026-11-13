<script>
  import { message } from './api.svelte.js';
  import Icon from './Icon.svelte';
  import { t } from './i18n.js';

  /**
   * Attachments of a message or a homework assignment. `link(file)` asks Librus where the file is and resolves to
   * { DownloadUrl }, which the browser opens itself.
   */
  let { link, files } = $props();
  let error = $state('');

  async function open(file) {
    error = '';
    // Opened inside the tap: after an await the browser counts window.open as a popup and blocks it.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const { DownloadUrl } = await link(file);
      if (!/^https:\/\//.test(DownloadUrl)) throw new Error('upstream');
      (tab ?? window).location.href = DownloadUrl;
    } catch (e) {
      tab?.close();
      error = message(e);
    }
  }
</script>

<ul class="files">
  {#each files as f, i (f.Id)}
    <li>
      <button class="link" onclick={() => open(f)}><Icon name="paperclip" size={18} />{f.Name || t('Załącznik {n}', { n: i + 1 })}</button>
    </li>
  {/each}
</ul>
{#if error}<p class="error" role="alert">{error}</p>{/if}
