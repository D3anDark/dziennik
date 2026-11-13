<script>
  import { api, post, session, net, clock, lookup, clearApiCache, inbox, update, drafts, DEMO } from './api.svelte.js';
  import { tick } from 'svelte';
  import { refreshUnread } from './webmail.js';
  import { initials, fmtUnix, alias, mail } from './util.js';
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
  import Settings from './Settings.svelte';
  import Activity from './Activity.svelte';
  import Install from './Install.svelte';
  import Privacy from './Privacy.svelte';
  import Tour from './Tour.svelte';
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
    ustawienia: { label: 'Ustawienia', icon: 'sliders', view: Settings, global: true },
    dostep: { label: 'Dostęp do aplikacji', icon: 'key', view: Access, global: true, admin: true },
    prywatnosc: { label: 'Prywatność', icon: 'eye', view: Privacy, global: true },
  };
  const TABS = ['start', 'oceny', 'plan', 'wiadomosci'];
  // The form in .github/ISSUE_TEMPLATE/bug.yml, its `server` field filled in.
  const ISSUES = `https://github.com/unisic/dziennik/issues/new?template=bug.yml&server=${encodeURIComponent(location.host)}`;
  // Days of this school year the demo can be seen on (main.js moves its clock there): around each semester's end.
  const year = new Date().getFullYear() - (new Date().getMonth() < 8);
  const DEMO_DAYS = [
    ['', 'dziś'],
    [`${year + 1}-01-18`, 'styczeń: koniec I semestru'],
    [`${year + 1}-03-16`, 'marzec: II semestr'],
    [`${year + 1}-06-08`, 'czerwiec: koniec roku'],
    [`${year + 1}-07-01`, 'lipiec: wakacje'],
  ];
  const demoDay = new URLSearchParams(location.search).get('dzien') ?? '';
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
  // Writing a message is a task of its own: the page keeps the back link and the send bar, not the tabs.
  const writing = $derived(route.page === 'wiadomosci' && /^nowa(\/|$)/.test(route.arg ?? ''));
  const accounts = $derived((session.me?.accounts ?? []).map((a) => (a.name ? { ...a, name: alias(a.name) } : a)));
  const name = $derived(accounts.find((a) => a.login === login)?.name ?? accounts[0]?.name ?? mail(session.me?.email ?? ''));

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

  /**
   * Each history entry remembers the route it was opened from (`history.state.from`); an entry that already has one
   * is being gone back (or forward) to. Then the page returns to where it was, otherwise it starts at the top.
   */
  const SCROLL_MAX = 30;
  const positions = new Map();
  let last = location.hash;
  let landing = 0;
  history.scrollRestoration = 'manual';

  /** The view loads after the route changes, so the old place is reached once the page is tall enough, or in 2 s. */
  function land(y) {
    const seq = ++landing;
    const end = performance.now() + 2000;
    const step = () => {
      if (seq !== landing) return;
      if (document.documentElement.scrollHeight - innerHeight >= y || performance.now() > end) scrollTo(0, y);
      else requestAnimationFrame(step);
    };
    step();
  }

  $effect(() => {
    const onHash = () => {
      positions.delete(last);
      positions.set(last, scrollY);
      if (positions.size > SCROLL_MAX) positions.delete(positions.keys().next().value);
      const revisit = history.state?.from !== undefined;
      if (!revisit) history.replaceState({ from: last }, '');
      last = hash = location.hash;
      land(revisit ? (positions.get(last) ?? 0) : 0);
      // A screen reader hears the new view by its heading; preventScroll leaves the place to land().
      tick().then(() => document.querySelector('main h1')?.focus({ preventScroll: true }));
    };
    // A link back to the view this one was opened from goes back in history instead, so the system back button
    // does not return here afterwards.
    const onClick = (e) => {
      const a = e.target.closest?.('a.back');
      if (a && history.state?.from === a.getAttribute('href')) {
        e.preventDefault();
        history.back();
      }
    };
    addEventListener('hashchange', onHash);
    addEventListener('click', onClick);
    return () => {
      removeEventListener('hashchange', onHash);
      removeEventListener('click', onClick);
    };
  });

  $effect(() => {
    const label = route.page === 'wiecej' ? 'Więcej' : route.page !== 'start' && PAGES[route.page]?.label;
    document.title = label ? `${label} · Dziennik` : 'Dziennik';
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
  <div class="shell" class:writing>
    <aside class="side">
      <div class="brandbar">
        <span class="wordmark">Dziennik</span>
        <button class="icon-btn" class:busy={net.busy > 0} onclick={() => clock.tick++} aria-label="Odśwież" title="Odśwież"><Icon name="refresh" size={18} /></button>
      </div>
      <div class="accounts" role="group" aria-label="Uczeń">
        {#each accounts as a (a.login)}
          <button class="nav-row account" aria-pressed={a.login === login} onclick={() => (login = a.login)}>
            <span class="avatar" aria-hidden="true">{initials(a.name ?? a.login)}</span>
            <span class="grow">{a.name ?? a.login}{#if about[a.login]}<small class="muted">{about[a.login]}</small>{/if}</span>
          </button>
        {:else}
          <span class="nav-row account">{mail(session.me.email)}</span>
        {/each}
      </div>
      <nav aria-label="Sekcje">
        {#each Object.keys(PAGES).filter((p) => visible(p) && p !== 'ustawienia') as p (p)}
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
        <div class="me">
          <small class="muted grow">{mail(session.me.email)}</small>
          <!-- Icons beside the logout one: rows of their own would make a 1280×800 sidebar scroll. -->
          <a class="button icon-btn" href="#/ustawienia" aria-current={route.page === 'ustawienia' ? 'page' : undefined} aria-label="Ustawienia" title="Ustawienia"><Icon name="sliders" size={18} /></a>
          <a class="button icon-btn" href={ISSUES} target="_blank" rel="noopener" aria-label="Zgłoś błąd" title="Zgłoś błąd"><Icon name="flag" size={18} /></a>
          <button class="icon-btn" onclick={logout} aria-label="Wyloguj" title="Wyloguj"><Icon name="logout" size={18} /></button>
        </div>
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

      {#if DEMO}
        <p class="banner" role="note">
          <span><strong>Wersja demo:</strong> przykładowe dane. <a href="https://github.com/unisic/dziennik">Kod i&nbsp;instalacja</a></span>
          <label>
            Data
            <!-- A new day is new data: the page loads again, as the demo's data is made once per load. -->
            <select value={demoDay} onchange={(e) => (location.search = e.currentTarget.value && `?dzien=${e.currentTarget.value}`)}>
              {#each DEMO_DAYS.some(([d]) => d === demoDay) ? DEMO_DAYS : [...DEMO_DAYS, [demoDay, demoDay]] as [d, label] (d)}
                <option value={d}>{label}</option>
              {/each}
            </select>
          </label>
        </p>
      {/if}
      {#if !net.online}
        <p class="banner" role="status"><span><strong>Offline:</strong> dane z ostatniego połączenia{net.synced ? ` (${fmtUnix(net.synced / 1000)})` : ''}.</span></p>
      {/if}
      <!-- Shown again once a message being written is sent or dropped; until then the new build waits. -->
      {#if update.ready && !drafts.open}
        <p class="banner" role="status">Jest nowa wersja aplikacji.<button class="secondary" onclick={() => location.reload()}>Zaktualizuj</button></p>
      {/if}

      <main tabindex="-1">
        {#if more.includes(route.page) && !route.arg}
          <p><a class="back" href="#/wiecej"><Icon name="left" size={18} />Więcej</a></p>
        {/if}
        <!-- A message and the form name themselves, under their own way back. -->
        {#if route.page !== 'start' && !(route.page === 'wiadomosci' && route.arg)}
          <h1 class="title" tabindex="-1">{route.page === 'wiecej' ? 'Więcej' : PAGES[route.page].label}</h1>
        {/if}
        {#if route.page === 'wiecej'}
          <!-- The student's pages, then the account's, as in the sidebar. -->
          {#each [more.filter((p) => !PAGES[p].global), more.filter((p) => PAGES[p].global)] as group, i (i)}
            {#if group.length}
              {#if i}<h2 class="section">Konto</h2>{/if}
              <ul class="card list menu">
                {#each group as p (p)}
                  <li>
                    <a href="#/{p}">
                      <span class="tile"><Icon name={PAGES[p].icon} size={20} /></span>
                      <span class="grow">{PAGES[p].label}</span>
                      <span class="chev"><Icon name="right" size={18} /></span>
                    </a>
                  </li>
                {/each}
              </ul>
            {/if}
          {/each}
          <Install />
          <a class="button wide" href={ISSUES} target="_blank" rel="noopener"><Icon name="flag" size={20} />Zgłoś błąd</a>
          <p class="center muted">Zalogowano jako {mail(session.me.email)}</p>
          <button class="secondary wide" onclick={logout}><Icon name="logout" size={20} />Wyloguj</button>
        {:else if route.page === 'ustawienia'}
          <Settings {logout} issues={ISSUES} />
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
  <Tour several={accounts.length > 1} />
{/if}
