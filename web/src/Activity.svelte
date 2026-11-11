<script>
  import { resource } from './api.svelte.js';
  import { ago } from './util.js';
  import { activity } from './data.js';
  import Async from './Async.svelte';
  import Icon from './Icon.svelte';
  import Mark from './Mark.svelte';

  /** The student's activity list. `limit` cuts it for the start page, which links to the whole list. */
  let { login, limit = Infinity } = $props();
  const list = resource(() => activity(login), () => `activity/${login}`);
  /** An entry carries the icon of the view it leads to, the same one the navigation shows. */
  const ICONS = { oceny: 'star', zachowanie: 'smile', frekwencja: 'check', uwagi: 'note', wiadomosci: 'mail', ogloszenia: 'megaphone', zadania: 'book', terminarz: 'calendar', plan: 'clock' };
</script>

<Async r={list} empty="Jeszcze nic. Pojawią się tu nowe, zmienione i usunięte oceny, nieobecności, uwagi, wiadomości i terminy.">
  {#snippet children(all)}
    <ul class="feed" class:card={limit === Infinity}>
      {#each all.slice(0, limit) as e (e.key)}
        <li>
          <a href="#/{e.page}">
            {#if e.grade}
              <span class="chip static {e.grade.tone}" class:final={e.grade.kind}><Mark value={e.grade.value} /></span>
            {:else}
              <!-- Something removed: the icon of its page struck through, so it does not read as something new there. -->
              <span class="tile"><Icon name={ICONS[e.page.split('/')[0]] ?? 'pulse'} off={e.gone} size={18} /></span>
            {/if}
            <span class="grow">{e.text}{#if e.grade}<small class="muted">{e.grade.name}</small>{/if}</span>
            <time>{ago(e.at)}</time>
          </a>
        </li>
      {/each}
    </ul>
  {/snippet}
</Async>
