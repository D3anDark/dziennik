<script>
  import { api, post, session, net, clock, lookup, clearApiCache, inbox } from './api.svelte.js';
  import { refreshUnread } from './webmail.js';
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
  import Topics from './Topics.svelte';
  import Access from './Access.svelte';
  import Push from './Push.svelte';
  import Activity from './Activity.svelte';
  import Install from './Install.svelte';
  import { sync as syncPush, disable as disablePush } from './push.js';

  const PAGES = {
    start: { label: 'Start', icon: 'home', view: Home },
    oceny: { label: 'Oceny', icon: 'star', view: Grades },
    plan: { label: 'Plan', icon: 'clock', view: Timetable },
    frekwencja: { label: 'Frekwencja', icon: 'check', view: Attendance },
    wiadomosci: { label: 'Wiadomości', icon: 'mail', view: Messages },
    terminarz: { label: 'Terminarz', icon: 'calendar', view: Calendar },
    aktywnosc: { label: 'Aktywność', icon: 'pulse', view: Activity },
    zadania: { label: 'Zadania domowe', icon: 'book', view: Homework },
    tematy: { label: 'Tematy lekcji', icon: 'list', view: Topics },
    ogloszenia: { label: 'Ogłoszenia', icon: 'megaphone', view: Notices },
    uwagi: { label: 'Uwagi', icon: 'note', view: Notes },
    zachowanie: { label: 'Zachowanie', icon: 'smile', view: Behaviour },
    nauczyciele: { label: 'Klasa i nauczyciele', icon: 'users', view: Teachers },
    // `global` pages are about the signed-in person, not about one student.
    powiadomienia: { label: 'Powiadomienia', icon: 'bell', view: Push, global: true },
    dostep: { label: 'Dostęp do aplikacji', icon: 'key', view: Access, global: true, admin: true },
  };
  const TABS = ['start', 'oceny', 'plan', 'wiadomosci'];
  const visible = (p) => Object.hasOwn(PAGES, p) && (!PAGES[p].admin || Boolean(session.me?.admin));
  const more = $derived(Object.keys(PAGES).filter((p) => !TABS.includes(p) && visible(p)));
  const STUDENT_KEY = 'student';

  let hash = $state(location.hash);
  let login = $state(readStudent());

  const route = $derived.by(() => {
    const [page, ...rest] = hash.replace(/^#\/?/, '').split('/');
    return { page: visible(page) || page === 'wiecej' ? page : 'start', arg: rest.join('/') || undefined };
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
    inbox.unread = undefined;
  });

  /**
   * What tells apart accounts that carry the same name. Usually they are one pupil's own account and a parent's
   * (Me.Account.GroupId 8 and 5, as seen live), so the role comes first and the class only if roles repeat too.
   * Read only when names repeat.
   */
  const ROLES = { 8: 'uczeń', 5: 'rodzic' };
  let facts = $state({});
  const twins = (a) => accounts.filter((x) => x !== a && x.name === a.name);
  $effect(() => {
    for (const a of accounts.filter((x) => twins(x).length)) {
      Promise.all([lookup(a.login, 'Me'), lookup(a.login, 'Classes')]).then(([me, c]) => {
        const cls = [c.Class?.Number, c.Class?.Symbol].filter((x) => x != null).join('');
        facts[a.login] = { role: ROLES[me.Me?.Account?.GroupId], cls: cls && `klasa ${cls}` };
      });
    }
  });
  const about = $derived.by(() => {
    const out = {};
    for (const a of accounts) {
      const [mine, others] = [facts[a.login], twins(a).map((x) => facts[x.login])];
      if (!mine || !others.length) continue;
      const telling = ['role', 'cls'].find((k) => mine[k] && others.every((o) => o?.[k] !== mine[k]));
      out[a.login] = telling ? mine[telling] : [mine.role, mine.cls, a.login].filter(Boolean).join(', ');
    }
    return out;
  });

  // Re-read on every navigation as well: messages can be read elsewhere meanwhile.
  $effect(() => {
    const [l] = [login, hash, clock.tick];
    if (l) refreshUnread(l);
  });

  // Devices are forgotten by the server with the last session; an existing subscription is sent again after sign-in.
  $effect(() => {
    if (session.me?.push) syncPush(session.me.push).catch(() => {});
  });

  async function logout() {
    // Signing out also ends notifications on this device, so the next person here does not get them.
    await disablePush().catch(() => {});
    // Offline logout still clears local state; the server session expires on its own.
    await post('logout').catch(() => {});
    await clearApiCache();
    session.me = null;
  }
</script>

{#if session.me === undefined}
  <p class="center muted" role="status">Ładowanie…</p>
{:else if !session.me}
  <Login />
{:else}
  <!-- The hash is the router, so the skip link moves focus instead of following an anchor. -->
  <button class="skip" onclick={() => document.querySelector('main').focus()}>Przejdź do treści</button>
  <div class="shell">
    <aside class="side">
      <div class="accounts">
        {#each accounts as a (a.login)}
          <button class="nav-row account" aria-pressed={a.login === login} onclick={() => (login = a.login)}>
            <span class="avatar" aria-hidden="true">{initials(a.name ?? a.login)}</span>
            <span class="grow">{a.name ?? a.login}{#if about[a.login]}<small class="muted">{about[a.login]}</small>{/if}</span>
          </button>
        {:else}
          <span class="nav-row account">{session.me.email}</span>
        {/each}
      </div>
      <nav aria-label="Sekcje">
        {#each Object.keys(PAGES).filter(visible) as p (p)}
          {#if p === 'powiadomienia'}<p class="group">Konto</p>{/if}
          <a class="nav-row" href="#/{p}" aria-current={route.page === p ? 'page' : undefined}>
            <Icon name={PAGES[p].icon} size={18} />
            <span class="grow">{PAGES[p].label}</span>
            {#if p === 'wiadomosci' && inbox.unread}<span class="badge">{inbox.unread}</span>{/if}
          </a>
        {/each}
      </nav>
      <div class="side-foot">
        <Install row />
        <button class="nav-row" class:busy={net.busy > 0} onclick={() => clock.tick++}><Icon name="refresh" size={18} />Odśwież</button>
        <button class="nav-row" onclick={logout}><Icon name="logout" size={18} />Wyloguj</button>
        <small class="muted">{session.me.email}</small>
      </div>
    </aside>

    <div class="view">
      <header class="bar">
        <span class="avatar" aria-hidden="true">{initials(name)}</span>
        {#if accounts.length > 1}
          <label class="picker">
            <select bind:value={login} aria-label="Uczeń">
              {#each accounts as a (a.login)}
                <option value={a.login}>{[a.name ?? a.login, about[a.login]].filter(Boolean).join(' · ')}</option>
              {/each}
            </select>
            <Icon name="down" size={18} />
          </label>
        {:else}
          <span class="student">{name}</span>
        {/if}
        <button class="icon-btn" class:busy={net.busy > 0} onclick={() => clock.tick++} aria-label="Odśwież" title="Odśwież">
          <Icon name="refresh" />
        </button>
      </header>

      {#if !net.online}
        <p class="banner" role="status">Offline: dane z ostatniego połączenia.</p>
      {/if}

      <main tabindex="-1">
        {#if more.includes(route.page) && !route.arg}
          <p><a class="back" href="#/wiecej"><Icon name="left" size={18} />Więcej</a></p>
        {/if}
        {#if route.page !== 'start'}
          <h1 class="title">{route.page === 'wiecej' ? 'Więcej' : PAGES[route.page].label}</h1>
        {/if}
        {#if route.page === 'wiecej'}
          <ul class="card list menu">
            {#each more as p (p)}
              <li>
                <a href="#/{p}">
                  <span class="tile"><Icon name={PAGES[p].icon} size={20} /></span>
                  <span class="grow">{PAGES[p].label}</span>
                  <span class="chev"><Icon name="right" size={18} /></span>
                </a>
              </li>
            {/each}
          </ul>
          <Install />
          <p class="center muted">Zalogowano jako {session.me.email}</p>
          <button class="secondary wide" onclick={logout}><Icon name="logout" size={20} />Wyloguj</button>
        {:else if PAGES[route.page].global}
          <View />
        {:else if !accounts.length}
          <p class="center muted">Do konta LIBRUS nie jest podpięte żadne konto ucznia.</p>
        {:else if login}
          {#key login}
            <View {login} arg={route.arg} />
          {/key}
        {/if}
      </main>
    </div>

    <nav class="tabs" aria-label="Sekcje">
      {#each [...TABS, 'wiecej'] as p (p)}
        {@const current = p === 'wiecej' ? !TABS.includes(route.page) : route.page === p}
        <a href="#/{p}" aria-current={current ? 'page' : undefined}>
          <span class="tab-icon">
            <Icon name={p === 'wiecej' ? 'grid' : PAGES[p].icon} size={22} />
            {#if p === 'wiadomosci' && inbox.unread}<span class="badge">{inbox.unread}</span>{/if}
          </span>
          {p === 'wiecej' ? 'Więcej' : PAGES[p].label}
        </a>
      {/each}
    </nav>
  </div>
{/if}
