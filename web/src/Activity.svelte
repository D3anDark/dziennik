<script>
  import { resource } from './api.svelte.js';
  import { ago } from './util.js';
  import { activity } from './data.js';
  import Async from './Async.svelte';
  import Icon from './Icon.svelte';

  /** The student's activity list. `limit` cuts it for the start page, which links to the whole list. */
  let { login, limit = Infinity } = $props();
  const list = resource(() => activity(login));
</script>

<Async r={list} empty="Jeszcze nic. Pojawią się tu nowe, zmienione i usunięte oceny, nieobecności, uwagi, wiadomości i terminy.">
  {#snippet children(all)}
    <ul class="feed" class:card={limit === Infinity}>
      {#each all.slice(0, limit) as e (e.key)}
        <li>
          <a href="#/{e.page}">
            {#if e.grade}
              <span class="chip static {e.grade.tone}">{e.grade.value}</span>
            {:else}
              <span class="tile"><Icon name="pulse" size={18} /></span>
            {/if}
            <span class="grow">{e.text}{#if e.grade}<small class="muted">{e.grade.name}</small>{/if}</span>
            <time>{ago(e.at)}</time>
          </a>
        </li>
      {/each}
    </ul>
  {/snippet}
</Async>
