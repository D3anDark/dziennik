<script>
  import { api, post, session, net, synergia, clearApiCache, inbox, refreshUnread } from './api.svelte.js';
  import { initials } from './util.js';
  import Icon from './Icon.svelte';
  import Login from './Login.svelte';
  import Home from './Home.svelte';
  import Grades from './Grades.svelte';
  import Timetable from './Timetable.svelte';
  import Attendance from './Attendance.svelte';
  import Calendar from './Calendar.svelte';
  import Homework from './Homework.svelte';
  import Messages from './Messages.svelte';
  import Notices from './Notices.svelte';
  import Notes from './Notes.svelte';
  import Behaviour from './Behaviour.svelte';
  import Teachers from './Teachers.svelte';

  const PAGES = {
    start: { label: 'Start', icon: 'home', view: Home },
    oceny: { label: 'Oceny', icon: 'star', view: Grades },
    plan: { label: 'Plan', icon: 'clock', view: Timetable },
    frekwencja: { label: 'Frekwencja', icon: 'check', view: Attendance },
    wiadomosci: { label: 'Wiadomości', icon: 'mail', view: Messages },
    terminarz: { label: 'Terminarz', icon: 'calendar', view: Calendar },
    zadania: { label: 'Zadania domowe', icon: 'book', view: Homework },
    ogloszenia: { label: 'Ogłoszenia', icon: 'megaphone', view: Notices },
    uwagi: { label: 'Uwagi', icon: 'note', view: Notes },
    zachowanie: { label: 'Zachowanie', icon: 'smile', view: Behaviour },
    nauczyciele: { label: 'Nauczyciele', icon: 'users', view: Teachers },
  };
  const TABS = ['start', 'oceny', 'plan', 'frekwencja'];
  const MORE = Object.keys(PAGES).filter((p) => !TABS.includes(p));
  const STUDENT_KEY = 'student';

  let hash = $state(location.hash);
  let login = $state(readStudent());
  let lucky = $state(null);

  const route = $derived.by(() => {
    const [page, ...rest] = hash.replace(/^#\/?/, '').split('/');
    return { page: Object.hasOwn(PAGES, page) || page === 'wiecej' ? page : 'start', arg: rest.join('/') || undefined };
  });
  const View = $derived(PAGES[route.page]?.view);
  const accounts = $derived(session.me?.accounts ?? []);
  const name = $derived(accounts.find((a) => a.login === login)?.name ?? accounts[0]?.name ?? session.me?.email ?? '');

  function readStudent() {
    try {
      return localStorage.getItem(STUDENT_KEY);
    } catch {
      return null;
    }
  }

  api('me').then(
    (me) => (session.me = me),
    () => (session.me ??= null),
  );

  $effect(() => {
    const onHash = () => {
      hash = location.hash;
      scrollTo(0, 0);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  });

  $effect(() => {
    if (accounts.length && !accounts.some((a) => a.login === login)) login = accounts[0].login;
  });

  $effect(() => {
    if (!login) return;
    try {
      localStorage.setItem(STUDENT_KEY, login);
    } catch {
      // private mode: the choice just is not remembered
    }
    inbox.login = login;
    inbox.unread = 0;
    let stale = false;
    lucky = null;
    synergia(login, 'LuckyNumbers').then(
      (r) => !stale && (lucky = r.LuckyNumber ?? null),
      () => {}, // optional widget: schools without lucky numbers answer with an error
    );
    return () => (stale = true);
  });

  // Re-read on every navigation as well: messages can be read elsewhere meanwhile.
  $effect(() => {
    const [l] = [login, hash];
    if (l) refreshUnread(l);
  });

  async function logout() {
    // Offline logout still clears local state; the server session expires on its own.
    await post('logout').catch(() => {});
    await clearApiCache();
    session.me = null;
  }
</script>

{#if session.me === undefined}
  <p class="center muted">Ładowanie…</p>
{:else if !session.me}
  <Login />
{:else}
  <header class="bar">
    <span class="avatar" aria-hidden="true">{initials(name)}</span>
    {#if accounts.length > 1}
      <label class="picker">
        <select bind:value={login} aria-label="Uczeń">
          {#each accounts as a (a.login)}
            <option value={a.login}>{a.name ?? a.login}</option>
          {/each}
        </select>
        <Icon name="down" size={18} />
      </label>
    {:else}
      <span class="student">{name}</span>
    {/if}
    {#if lucky?.LuckyNumber}
      <span class="lucky" title="Szczęśliwy numerek na {lucky.LuckyNumberDay}">Numerek <strong>{lucky.LuckyNumber}</strong></span>
    {/if}
    <button class="icon-btn" onclick={logout} aria-label="Wyloguj" title="Wyloguj"><Icon name="logout" /></button>
  </header>

  {#if !net.online}
    <p class="banner" role="status">Offline: dane z ostatniego połączenia.</p>
  {/if}

  <main>
    <h1 class="title">{route.page === 'wiecej' ? 'Więcej' : PAGES[route.page].label}</h1>
    {#if !accounts.length}
      <p class="center muted">Do konta LIBRUS nie jest podpięte żadne konto ucznia.</p>
    {:else if route.page === 'wiecej'}
      <ul class="card list menu">
        {#each MORE as p (p)}
          <li>
            <a href="#/{p}">
              <span class="tile"><Icon name={PAGES[p].icon} /></span>
              <span class="grow">{PAGES[p].label}</span>
              {#if p === 'wiadomosci' && inbox.unread}<span class="badge">{inbox.unread}</span>{/if}
              <span class="chev"><Icon name="right" size={18} /></span>
            </a>
          </li>
        {/each}
      </ul>
    {:else if login}
      {#key login}
        <View {login} arg={route.arg} />
      {/key}
    {/if}
  </main>

  <nav class="tabs" aria-label="Sekcje">
    {#each [...TABS, 'wiecej'] as p (p)}
      {@const current = p === 'wiecej' ? !TABS.includes(route.page) : route.page === p}
      <a href="#/{p}" aria-current={current ? 'page' : undefined}>
        <span class="tab-icon">
          <Icon name={p === 'wiecej' ? 'grid' : PAGES[p].icon} size={24} />
          {#if p === 'wiecej' && inbox.unread}<span class="badge">{inbox.unread}</span>{/if}
        </span>
        {p === 'wiecej' ? 'Więcej' : PAGES[p].label}
      </a>
    {/each}
  </nav>
{/if}
