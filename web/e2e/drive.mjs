import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';

const [, , cdpPort, out, base, mockPid] = process.argv;
const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let seq = 0;
const pending = new Map();
const problems = [];
// confirm() blocks the page until answered; `accept` is the answer, `text` the last question asked.
const dialog = { accept: true, text: '' };
let swRegistration;
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'ServiceWorker.workerRegistrationUpdated') {
    swRegistration = msg.params.registrations[0]?.registrationId ?? swRegistration;
  } else if (msg.method === 'Page.javascriptDialogOpening') {
    dialog.text = msg.params.message;
    send('Page.handleJavaScriptDialog', { accept: dialog.accept });
  } else if (msg.method === 'Runtime.exceptionThrown') {
    problems.push('exception: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    problems.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (expr, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await js(expr)) return true;
  return false;
};
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
};
const shot = async (name) => {
  await sleep(250); // let 150ms transitions (a button turning secondary, a chevron turning) settle
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${out}/${name}.png`, Buffer.from(data, 'base64'));
};
const clickText = (sel, text) =>
  js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`);
const text = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText.trim())`);
const log = async () => (await (await fetch(`${base}/__log`)).json());
const check = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + JSON.stringify(detail) : ''}`);
const fill = (pw) =>
  js(`(() => { const [e, p] = document.querySelectorAll('form.login input');
    for (const [el, v] of [[e, 'rodzic@example.com'], [p, ${JSON.stringify(pw)}]]) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
    document.querySelector('form.login').requestSubmit(); })()`);


const go = async (hash, ready) => {
  await js(`location.hash = ${JSON.stringify(hash)}`);
  return until(ready);
};
const loaded = `!document.querySelector('main')?.innerText.includes('Ładowanie')`;
const mainText = () => js(`document.querySelector('main').innerText`);
const rows = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
const hasButton = (label) => `[...document.querySelectorAll('main button')].some((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
/** Clicks an attachment with window.open stubbed: the URL the tab was sent to, or 'closed' when the app gave up. */
const openFile = async (name) => {
  await js(`window.open = () => (window.__tab = { location: {}, closed: false, close() { this.closed = true; } })`);
  await clickText('.files button', name);
  await until(`!!window.__tab && (window.__tab.closed || !!window.__tab.location.href)`);
  return js(`window.__tab.closed ? 'closed' : window.__tab.location.href`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true });
// The app decides by the clock whether today's lessons are over. Pinned before school on every load, so a run
// does not depend on the hour; checks that need another time set it and put this one back.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.prototype.toTimeString = () => '07:30:00 GMT+0100'` });
await send('Page.navigate', { url: base + '/' });
await sleep(1000);

check('login form shown when unauthenticated', await js(`!!document.querySelector('form.login')`));
await js(`document.querySelector('form.login details').open = true`);
await sleep(400);
check('privacy: the notice names who runs the server before anyone signs in', await js(`document.querySelector('form.login .privacy')?.textContent.includes('Jan Testowy, jan@example.com')`));
await fill('zle');
await sleep(400);
const alert = await text('[role=alert]');
check('bad password message', alert[0] === 'Nieprawidłowy e-mail lub hasło.', alert);

await fill('dobre');
await until(`!!document.querySelector('header.bar select')`);
await until(`document.querySelectorAll('main .events li').length > 0 && ${loaded}`);
// Headless Chromium has no push service, so the browser side is a stub: what is checked is what the app does with it.
const pushStub = `
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e', options: {}, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, async unsubscribe() { window.__sub = null; return true; } };
  PushManager.prototype.subscribe = async function (options) { window.__key = new Uint8Array(options.applicationServerKey).length; return (window.__sub = sub); };
  PushManager.prototype.getSubscription = async () => window.__sub ?? null;
  Notification.requestPermission = async () => 'granted';
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });`;
// Each step: its title and count, the lit rect, whether the card stays on screen and off the lit part.
const tourStep = () =>
  js(`(() => { const s = document.querySelector('dialog.tour .step'), spot = document.querySelector('dialog.tour .spot'); if (!s) return null;
    const a = s.getBoundingClientRect(), b = spot.getBoundingClientRect();
    return { title: s.querySelector('h2').textContent.replaceAll('\u00a0', ' '), count: s.querySelector('small').textContent.replaceAll('\u00a0', ' '),
      spot: [b.left, b.top, b.width, b.height].map(Math.round),
      apart: b.width === 0 || a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right,
      inside: a.left >= 0 && a.top >= 0 && a.right <= innerWidth && a.bottom <= innerHeight }; })()`);
const rectOf = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left - 4, r.top - 4, r.width + 8, r.height + 8].map(Math.round); })()`);
// Goes through the tour with Dalej, taking a shot or doing something on the steps named.
const walkTour = async (shots = {}, actions = {}) => {
  const steps = [];
  for (let n = 0; n < 20; n++) {
    await sleep(400); // the light moves in 300ms
    const s = await tourStep();
    steps.push(s);
    if (shots[s.title]) await shot(shots[s.title]);
    await actions[s.title]?.();
    if (!(await clickText('dialog.tour button', n ? 'Dalej' : 'Pokaż'))) break;
  }
  return steps;
};
check('tour: opens once signed in, modal over the app, the focus on its first step', await until(`document.querySelector('dialog.tour')?.matches(':modal') === true`) &&
  (await js(`document.activeElement?.textContent === 'Pokaż'`)));
await shot('0-tour');
const phoneTour = await walkTour({ Oceny: '0-tour-grades', Powiadomienia: '0-tour-push' });
const phoneTitles = phoneTour.map((t) => t.title);
check('tour (phone): every part in turn, the tab bar and the student switch, notifications offered last',
  JSON.stringify(phoneTitles.slice(0, 8)) === JSON.stringify(['Witaj w Dzienniku', 'Start', 'Oceny', 'Plan', 'Wiadomości', 'Więcej', 'Uczeń', 'Odświeżanie']) &&
  (phoneTitles.length === 8 || phoneTitles[8] === 'Powiadomienia') && phoneTour.at(-1).count === `${phoneTour.length} z ${phoneTour.length}`, phoneTitles);
check('tour (phone): each card on screen and off the part it is about', phoneTour.every((t) => t.apart && t.inside), phoneTour.filter((t) => !t.apart || !t.inside));
check('tour (phone): the light sits on the tab it names', JSON.stringify(phoneTour[2].spot) === JSON.stringify(await rectOf('.tabs a[href="#/oceny"]')), [phoneTour[2].spot, await rectOf('.tabs a[href="#/oceny"]')]);
if (phoneTitles.at(-1) === 'Powiadomienia') check('tour: notifications can be turned on from the tour', await js(`[...document.querySelectorAll('dialog.tour button')].some((b) => b.textContent.trim() === 'Włącz powiadomienia')`));
await clickText('dialog.tour button', 'Wstecz');
await sleep(400);
check('tour: Wstecz goes a step back', (await tourStep()).title === phoneTitles.at(-2));
await clickText('dialog.tour button', 'Dalej');
await clickText('dialog.tour button', 'Zaczynamy');
check('tour: closed for good on this device', await until(`!document.querySelector('dialog.tour') && localStorage.getItem('tour-seen') === '1'`));
const greeting = await text('.greeting > *');
check('start is default page, opened by a greeting with the date and the lucky number', ['Dzień dobry', 'Dobry wieczór'].includes(greeting[0]) && /^\p{L}+, \d+ \p{L}+ · Szczęśliwy numerek 13$/u.test(greeting[1]) && !(await js(`!!document.querySelector('h1.title')`)), greeting);
check('start: the page is named by the app alone', (await js('document.title')) === 'Dziennik', await js('document.title'));
const start = await mainText();
const weekday = !(await js(`[0,6].includes(new Date().getDay())`));
const friday = (await js(`new Date().getDay()`)) === 5;
await until(`document.querySelectorAll('.news a').length === 2`);
const news = await rows('.news a');
check('start: what is new as links into its pages, nothing at zero, lessons left to the day panel', JSON.stringify(news) === JSON.stringify(['1 nowa wiadomość', '1 nowa ocena']) &&
  (await js(`document.querySelector('.news a').getAttribute('href')`)) === '#/wiadomosci', news);
const feed = await rows('.panels .feed li');
check('start: activity shows edits and removals, a changed grade with its value, unknown kinds left out', feed.length === 5 && /^4\+ Zmieniona ocenaMatematyka \d+ min$/.test(feed[0]) && feed[1].startsWith('Nowy wpis we frekwencji ') &&
  feed[2].startsWith('Usunięta ocena ') && feed[3].startsWith('Zmiana w planie lekcji ') && feed[4].startsWith('Nowa wiadomość '), feed);
check('start: unread count on the messages tab', JSON.stringify(await text('nav.tabs a[href="#/wiadomosci"] .badge')) === '["1"]' && (await text('nav.tabs .badge')).length === 1, await text('nav.tabs .badge'));
const firstH2 = (await text('main section h2'))[0];
check('start: next lesson day', (await js(`[0,6].includes(new Date().getDay())`)) ? firstH2 !== 'Dziś' : firstH2 === 'Dziś', firstH2);
check('start: lessons listed', start.includes('Matematyka') && /sala\s104/.test(start), start);
const recent = await text('main .entries li .chip');
check('start: recent grades newest first', recent[0] === '4+' && recent.length === 6, recent);
const ev = await text('main .events li strong');
check('start: 14-day events, far ones excluded',
  ev.includes('Sprawdzian: Matematyka') && ev.includes('Nieobecność nauczyciela: Piotr') && ev.includes('Wycieczka klasowa') && !ev.includes('Wywiadowka'), ev);
await shot('1-start');

const gradeLoads = async () => (await log()).filter((l) => l === 'GET /api/s/1001u/Grades').length;
const loadsBefore = await gradeLoads();
const blanked = await js(`new Promise((done) => { document.querySelector('header button[aria-label=Odśwież]').click(); setTimeout(() => done(document.querySelector('main').innerText.includes('Ładowanie')), 0); })`);
await until(`!document.querySelector('header .busy')`);
check('refresh: the button loads the screen again and keeps it visible meanwhile', !blanked && (await gradeLoads()) === loadsBefore + 1 && (await text('main .entries li .chip')).length === 6, { blanked });
check('logout is not in the header any more', !(await js(`!!document.querySelector('header button[aria-label=Wyloguj]')`)));
if (weekday) {
  // The lesson in progress, or the next one, is marked on today's card; the clock is pinned for the check.
  const at = async (time) => {
    await js(`Date.prototype.toTimeString = () => ${JSON.stringify(time + ':00 GMT+0100')}`);
    await js(`document.querySelector('header button[aria-label=Odśwież]').click()`);
    await sleep(100);
    await until(`!document.querySelector('header .busy')`);
    return rows('.lessons li.current');
  };
  const marks = [await at('08:20'), await at('08:50'), await at('23:00')];
  check('start: lesson in progress, then the next one, nothing after school', marks[0].length === 1 && /Matematyka.*do końca 25 min/.test(marks[0][0]) && marks[1].length === 1 && /Fizyka.*następna/.test(marks[1][0]) && marks[2].length === 0, marks);
  const after = [(await text('.panels .card h2'))[0], await js(`document.querySelector('.panels .card').classList.contains('today')`)];
  check('start: after the last lesson the plan moves to the next school day', !after[1] && (friday ? /^poniedziałek, /.test(after[0]) : after[0] === 'Jutro'), after);
  await at('07:30');
}

await go('#/oceny', `document.querySelectorAll('main h2').length > 0`);
const subjects = await text('main h2');
check('a view is named in the title and its heading takes the focus', (await js('document.title')) === 'Oceny · Dziennik' && (await js(`document.activeElement === document.querySelector('main h1')`)), await js('document.title'));
check('grades: subjects sorted, "Inne" after the named ones, unknown ids not merged', JSON.stringify(subjects) === JSON.stringify(['Język polski', 'Matematyka', 'Inne', 'Inne']), subjects);
check('tab current', (await text('nav.tabs a[aria-current=page]'))[0] === 'Oceny');
const mat = await js(`[...document.querySelectorAll('main section')].find((s) => s.querySelector('h2').textContent === 'Matematyka').innerText`);
check('grades: semestral split, average at the subject, zero averages hidden', /Semestralna\s+5/.test(mat) && mat.includes('śr. I sem. 4,67') && !mat.includes('II sem. 0'), mat);
const freshBefore = await js(`[...document.querySelectorAll('.chip.fresh')].map((c) => c.getAttribute('aria-label'))`);
const keyBefore = (await text('.fresh-key'))[0];
await clickText('.chip', '4+');
await sleep(100);
const det = (await text('.detail'))[0] ?? '';
check('grades: detail with weight and teacher', det.startsWith('Kartkówka · waga 2\n') && det.endsWith(' · Anna Nowak'), det);
check('grades: a grade added this week is new until opened, then its dot goes', JSON.stringify(freshBefore) === JSON.stringify(['Ocena 4+, nowa']) &&
  (await js(`document.querySelectorAll('.chip.fresh').length`)) === 0 && (await js(`localStorage.getItem('seen-grades/1001u')`)) === '["Grades/2"]' &&
  keyBefore === 'nowa ocena: kropka znika po jej otwarciu' && !(await js(`!!document.querySelector('.fresh-key')`)), { freshBefore, keyBefore });
await shot('2-grades');

// A phone opens the plan at one day, in a strip of its week's school days.
await go('#/plan', `document.querySelectorAll('.days button').length === 5 && !!document.querySelector('main section .lessons')`);
const strip = await js(`[...document.querySelectorAll('.days button')].map((b) => ({ name: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), today: b.getAttribute('aria-current') }))`);
check('plan: a phone opens at one day, picked from the school days of its week, today marked',
  (await js(`document.querySelectorAll('main section').length`)) === 1 && strip.filter((d) => d.pressed === 'true').length === 1 &&
  (weekday ? strip.find((d) => d.today === 'date')?.pressed === 'true' : !strip.some((d) => d.today)), strip);
check('plan: a day with a cancelled or substituted lesson says so in its name, a cancelled one in red', strip[1]?.name.endsWith(', odwołane lekcje') &&
  strip[2]?.name.endsWith(', zmiany w planie') && strip[0]?.name.split(', ').length === 2 &&
  JSON.stringify(await js(`[...document.querySelectorAll('.days .dot')].map((d) => d.className.replace(/svelte-\\S+/g, '').trim())`)) ===
  JSON.stringify(['dot', 'dot on alert', 'dot on', 'dot', 'dot']), strip);
const todayButton = `[...document.querySelectorAll('.pager button')].find((b) => b.textContent === 'Dziś')`;
check('plan: "Dziś" is off while the view follows the lessons', await js(`${todayButton}.disabled`));
await js(`document.querySelectorAll('.days button')[0].click()`);
await until(`document.querySelector('main section h2').innerText.startsWith('poniedziałek')`);
const monday = await js(`document.querySelector('main section').innerText`);
check('plan: a picked day shows its lessons', /1\s+08:00\s*–\s*08:45\s+Matematyka/.test(monday) &&
  (await js(`document.querySelectorAll('.days button')[0].getAttribute('aria-pressed')`)) === 'true' && !(await js(`${todayButton}.disabled`)), monday);
await js(`document.querySelectorAll('.days button')[2].click()`);
await until(`document.querySelector('main section h2').innerText.startsWith('środa')`);
const changed = [await text('.lessons s.was'), await text('.lessons .change')];
const swapped = await js(`(() => { const li = document.querySelector('.lessons s.was').closest('li'); return [li.querySelector('.name').textContent, li.querySelector('small.muted').textContent.trim()]; })()`);
check('plan: a substitution strikes out the subject and teacher it replaced, beside the current ones, with the note',
  JSON.stringify(changed) === JSON.stringify([['Język polski', 'Piotr'], ['Przynieście zeszyty']]) &&
  JSON.stringify(swapped) === JSON.stringify(['Język polski, teraz Fizyka', 'Piotr, teraz Anna Nowak · sala\u00a0104']), { changed, swapped });
await sleep(200);
await shot('3-plan-day');
await clickText('.segmented button', 'Tydzień');
check('plan: the week view is remembered', (await until(`document.querySelectorAll('.week .column').length === 5`)) && (await js(`localStorage.getItem('plan-view')`)) === 'week');
await go('#/start', loaded);
// The opened 4+ is no longer counted on Start (the panel refreshes behind the remembered answer).
check('start: an opened grade is not counted as new any more', await until(`document.querySelectorAll('.news a').length === 1`) &&
  (await rows('.news a'))[0] === '1 nowa wiadomość', await rows('.news a'));
const COLUMNS = `document.querySelectorAll('.week .column').length === 5`;
await go('#/plan', COLUMNS);
const said = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((b) => b.getAttribute('aria-label'))`);
const saidOn = (day) => js(`[...document.querySelectorAll('.week .column')[${day}].querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))`);
const firstDay = await saidOn(0);
check('plan: the week on a clock, lessons in order, each read out with its teacher and room', JSON.stringify(firstDay.slice(0, 2)) ===
  JSON.stringify(['08:00–08:45, Matematyka, Anna Nowak, sala\u00a0104', '08:55–09:40, Fizyka, Anna Nowak, sala\u00a0104']) &&
  firstDay[2]?.startsWith('09:50–10:35, Język polski') && firstDay[2].includes('sala gim.') && !firstDay[2].includes('sala sala'), firstDay);
const geometry = await js(`(() => { const [a, b] = [...document.querySelectorAll('.week .column')[0].querySelectorAll('button')].map((x) => x.getBoundingClientRect());
  return { ppm: parseFloat(getComputedStyle(document.querySelector('.week')).getPropertyValue('--ppm')), height: a.height, gap: b.top - a.bottom }; })()`);
check('plan: a lesson as tall as it lasts, a break as the room between', Math.abs(geometry.height - 45 * geometry.ppm) <= 3 && Math.abs(geometry.gap - 10 * geometry.ppm) <= 3, geometry);
check('plan: canceled lesson marked', (await js(`document.querySelectorAll('.week li.canceled').length`)) === 1 &&
  (await said('.week li.canceled button'))[0].endsWith(', odwołana'));
const sub = (await saidOn(2)).find((l) => l.includes('zastępstwo'));
check('plan: a substitution is flagged and says what it replaced', sub?.endsWith('zastępstwo, zamiast: Język polski, Piotr') &&
  (await js(`!!document.querySelectorAll('.week .column')[2].querySelector('small .dot.on')`)), sub);
// The calendar's Matematyka test two days ahead, given at lesson 3 (Język polski there), and another group's test in a
// subject not in this plan yesterday. In this week's view Monday to Wednesday, and yesterday's too from Tuesday.
const dow = await js(`new Date().getDay()`);
if (dow >= 1 && dow <= 3) {
  await until(`!!document.querySelector('.week .tag.exam')`);
  const test = await js(`[...document.querySelectorAll('.week .tag.exam')].map((t) => [t.textContent, t.closest('button').getAttribute('aria-label')])`);
  check('plan: a test shows on its subject\'s lesson, not at the wrong lesson number it was given', test.length === 1 && test[0][0] === 'Sprawdzian' &&
    test[0][1].startsWith('08:00–08:45, Matematyka') && test[0][1].endsWith(', Sprawdzian: Funkcje liniowe'), test);
  if (dow >= 2) check('plan: a test in a subject not in the plan (another group\'s) is left out', !(await js(`document.querySelector('main').innerText.includes('Statystyka')`)) && test.length === 1);
}
check('plan: the week range is named', /^\d+(–| – )\d+ \p{L}+$|^\d+ \p{L}+ – \d+ \p{L}+$/u.test((await text('.range'))[0]), await text('.range'));
await shot('3-plan');
await js(`document.querySelectorAll('.week .column')[0].querySelector('button').click()`);
check('plan: a lesson tapped in the week opens its day, the week still the remembered view',
  (await until(`document.querySelector('main section h2')?.innerText.startsWith('poniedziałek')`)) && (await js(`localStorage.getItem('plan-view')`)) === 'week');
await clickText('.segmented button', 'Tydzień');
await until(COLUMNS);
if (weekday) {
  check('plan: opens at this week, today marked', await js(`!!document.querySelector('.week .wday[aria-current=date]')`));
  // After school the same view opens at the next school day; on a Friday that is the week after.
  await js(`Date.prototype.toTimeString = () => '23:00:00 GMT+0100'`);
  await go('#/start', loaded);
  await go('#/plan', COLUMNS);
  await sleep(200);
  const later = await js(`!!document.querySelector('.week .wday[aria-current=date]')`);
  check('plan: after the last lesson on a Friday it opens at the week after', friday ? !later : later, later);
  await js(`Date.prototype.toTimeString = () => '07:30:00 GMT+0100'`);
  await go('#/start', loaded);
  await go('#/plan', COLUMNS);
}
const before = (await log()).filter((l) => l.includes('Timetables')).length;
await js(`document.querySelector('[aria-label="Następny tydzień"]').click()`);
await sleep(600);
check('plan: next week requested', (await log()).filter((l) => l.includes('Timetables')).length === before + 1);

// Swipes, as real touch input. The page follows the finger, a short drag goes back, a long one or a flick turns it.
const weeks = async () => (await log()).filter((l) => l.includes('Timetables')).length;
const drag = async (points, pause = 30) => {
  for (const [i, [x, y]] of points.entries()) {
    await send('Input.dispatchTouchEvent', { type: i ? 'touchMove' : 'touchStart', touchPoints: [{ x, y }] });
    await sleep(pause);
  }
};
const lift = () => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const offset = () => js(`new DOMMatrix(getComputedStyle(document.querySelector('.swipe')).transform).m41`);
const rest = () => until(`getComputedStyle(document.querySelector('.swipe')).transform === 'none'`, 4000);
await js(`scrollTo(0, 0)`);
let count = await weeks();
await drag([[300, 420], [280, 420], [240, 421], [220, 421]]);
const followed = await offset();
await sleep(150);
await lift();
check('swipe: the page follows the finger and a short drag is taken back', followed <= -60 && followed >= -80 && (await rest()) && (await weeks()) === count, followed);
await drag([[330, 420], [300, 420], [220, 421], [140, 421], [90, 422]]);
await sleep(150);
await lift();
check('swipe: a long drag to the left turns to the next week', (await rest()) && (await weeks()) === count + 1, await weeks());
count = await weeks();
await drag([[120, 420], [150, 420], [215, 420]], 12);
await lift();
check('swipe: a quick flick to the right turns back, short as it is', (await rest()) && (await weeks()) === count + 1, await weeks());
count = await weeks();
await drag([[200, 300], [202, 360], [204, 430], [205, 500]]);
await lift();
check('swipe: a vertical drag is not a swipe', (await rest()) && (await weeks()) === count, await weeks());
await clickText('.segmented button', 'Dzień');
await js(`document.querySelectorAll('.days button')[4].click()`);
count = await weeks();
await drag([[330, 420], [300, 420], [220, 421], [140, 421], [90, 422]]);
await sleep(150);
await lift();
check('swipe: in the day view it steps one school day, from Friday past the weekend',
  (await rest()) && (await until(`document.querySelector('main section h2').innerText.startsWith('poniedziałek')`)) && (await weeks()) === count + 1, await text('main section h2'));

await go('#/frekwencja', `document.querySelectorAll('main .totals').length === 2`);
const totals = await rows('main section:nth-of-type(1) .totals li');
check('attendance: percentage, and unexcused absences counted apart from excused ones', JSON.stringify(totals) === JSON.stringify(
  ['nb Nieusprawiedliwione 1', 'u Usprawiedliwione 1', 'sp Spóźnienia 1']) && (await text('main .figure'))[0] === '60,0% obecności' &&
  JSON.stringify(await text('main .totals strong.alert')) === JSON.stringify(['1']), totals);
const per = await rows('main section:nth-of-type(2) .totals li');
check('attendance: per subject, the unexcused first', JSON.stringify(per) === JSON.stringify(['Matematyka 1 nieuspr. 50,0%', 'Inne 1 uspr. 66,7%']), per);
const marks = () => js(`[...document.querySelectorAll('.entries .chip')].map((c) => c.classList[2] + ':' + c.textContent)`);
check('attendance: presence filtered, every kind has its own mark', JSON.stringify(await marks()) === JSON.stringify(['g0:u', 'g0:sp', 'g1:nb']), await marks());
await js(`document.querySelector('.filter button[title="Nieusprawiedliwione"]').click()`);
check('attendance: the list narrows to one kind', JSON.stringify(await marks()) === JSON.stringify(['g1:nb']) &&
  (await js(`document.querySelector('.filter [aria-pressed=true]').innerText`)) === 'Nieuspr.', await marks());
await clickText('.filter button', 'Wszystkie');
check('attendance: and back to all', (await marks()).length === 3);
await shot('4-attendance');

await go('#/wiecej', `document.querySelectorAll('.menu a').length > 0`);
const menu = await text('.menu a');
check('more: menu', menu.length === 12 && menu[0] === 'Frekwencja' && menu.includes('Aktywność') && !menu.some((m) => m.startsWith('Wiadomości')) && menu.includes('Tematy lekcji') && menu.includes('Powiadomienia') && menu.includes('Dostęp do aplikacji') && menu.includes('Prywatność'), menu);
check('more: tab current', (await text('nav.tabs a[aria-current=page]'))[0]?.endsWith('Więcej'));
check('install: no button until the browser offers the app', !(await js(hasButton('Zainstaluj aplikację'))));
await js(`(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => (window.__asked = true); e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.__prevented = !dispatchEvent(e); })()`);
await until(hasButton('Zainstaluj aplikację'));
await clickText('main button', 'Zainstaluj aplikację');
await until(`!${hasButton('Zainstaluj aplikację')}`);
check('install: the offer is held back, asked on the button, and the button goes once answered', (await js(`window.__prevented && window.__asked === true`)) && !(await js(hasButton('Zainstaluj aplikację'))));
check('install: no Android advice off Android', !(await mainText()).includes('na Androidzie'));
check('more: account and logout live here', (await mainText()).includes('Zalogowano jako rodzic@example.com') && (await js(hasButton('Wyloguj'))));
await shot('5-more');
check('more: a bug report opens the issues apart from the app', await js(`(() => { const a = [...document.querySelectorAll('main a')].find((e) => e.textContent.trim() === 'Zgłoś błąd'); return a?.href === 'https://github.com/D3anDark/dziennik/issues/new?template=bug.yml&server=127.0.0.1%3A18081' && a.target === '_blank'; })()`));

await go('#/terminarz', `document.querySelectorAll('main .events li').length > 0`);
const cal = await text('main .events li strong');
check('calendar: month events incl. HomeWorks', cal.includes('Sprawdzian: Matematyka') && cal.includes('Wycieczka klasowa'), cal);
check('calendar: range end shown', (await mainText()).includes('do '));
check('more tab current on subpage', (await text('nav.tabs a[aria-current=page]'))[0]?.endsWith('Więcej'));
check('subpage: a way back to the menu', (await js(`document.querySelector('main a.back')?.getAttribute('href')`)) === '#/wiecej' && (await text('main a.back'))[0] === 'Więcej');
await shot('6-calendar');
const isoDay = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; };
const [ty, tm, td] = isoDay(0);
const inMonth = (n) => { const [y, m] = isoDay(n); return y === ty && m === tm; };
const grid = await js(`(() => { const g = document.querySelector('.month .grid'); return { days: g.querySelectorAll('button').length, lead: [...g.children].findIndex((c) => c.tagName === 'BUTTON'), rows: g.children.length % 7,
  today: g.querySelector('[aria-current=date] .num')?.textContent }; })()`);
check('calendar: a month grid, Monday first, today marked', grid.days === new Date(ty, tm, 0).getDate() && grid.lead === (new Date(ty, tm - 1, 1).getDay() + 6) % 7 && grid.rows === 0 && grid.today === String(td), grid);
const dayButton = (n) => `[...document.querySelectorAll('.month .grid button')].find((b) => b.querySelector('.num').textContent === '${isoDay(n)[2]}')`;
if (inMonth(2)) {
  const two = await js(`(() => { const b = ${dayButton(2)}; return { names: [...b.querySelectorAll('.ev')].map((m) => m.className + ' ' + m.textContent), label: b.getAttribute('aria-label') }; })()`);
  check('calendar: a day names what is on it, its kind by colour, and says how many in words', JSON.stringify(two.names) === JSON.stringify(['ev event Sprawdzian: Matematyka', 'ev teacher Nieobecność nauczyciela: Piotr']) &&
    two.label.endsWith('2 wpisy: Sprawdzian: Matematyka; Nieobecność nauczyciela: Piotr'), two);
}
if (inMonth(5) && inMonth(6)) check('calendar: a free day spanning two days tints and names both', await js(`[5, 6].every((n) => { const b = n === 5 ? ${dayButton(5)} : ${dayButton(6)}; return b.classList.contains('free') && b.querySelector('.ev.free')?.textContent === 'Wycieczka klasowa'; }) && !${dayButton(4)}.classList.contains('free')`));
await until(`document.querySelectorAll('.soon li').length === 3`);
const soonTiles = await text('.soon li strong');
check('calendar: the three nearest entries as tiles', JSON.stringify(soonTiles) === JSON.stringify(['Sprawdzian: Matematyka', 'Nieobecność nauczyciela: Piotr', 'Wycieczka klasowa']), soonTiles);
await js(`[...document.querySelectorAll('.soon button')][2].click()`);
await until(`document.querySelectorAll('main .events li').length === 1 && ${loaded}`);
check('calendar: a tile opens its day, the list down to that day', JSON.stringify(await text('main .events li strong')) === JSON.stringify(['Wycieczka klasowa']) &&
  (await js(`${dayButton(5)}.getAttribute('aria-pressed')`)) === 'true' && (await js(hasButton('Cały miesiąc'))));
check('calendar: on a phone the picked day\'s entries are scrolled into sight', await js(`(() => { const r = document.querySelector('main .events li').getBoundingClientRect(); return r.top >= 0 && r.bottom <= document.querySelector('.tabs').getBoundingClientRect().top; })()`));
await shot('6-calendar-day');
await clickText('main button', 'Cały miesiąc');
check('calendar: and back to the whole month', await until(`document.querySelectorAll('main .events li').length > 1 && !document.querySelector('.month [aria-pressed=true]')`));
await clickText('main button', 'Dziś');
await until(`document.querySelector('.month [aria-current=date]') && ${loaded}`);
const empty = await js(`(() => { const b = [...document.querySelectorAll('.month .grid button')].find((b) => !b.querySelector('.ev')); b.click(); return b.getAttribute('aria-label'); })()`);
check('calendar: a day with nothing says so', await until(`document.querySelector('main .swipe')?.innerText.includes('Tego dnia nic nie ma.')`), empty);
await clickText('main button', 'Cały miesiąc');
await js(`document.querySelector('[aria-label="Następny miesiąc"]').click()`);
await until(loaded);
const m2 = new Date(); m2.setMonth(m2.getMonth() + 1, 1);
check('calendar: next month requested', (await log()).some((l) => l.includes(`Calendars/7?month=${m2.getMonth() + 1}&year=${m2.getFullYear()}`)));

await go('#/zadania', `document.querySelectorAll('main details').length === 2`);
const hw = await text('main details summary');
check('homework: sorted by due, subject via lesson', hw[0].startsWith('Wypracowanie') && /Język\spolski/.test(hw[0]) && hw[0].includes('termin'), hw);
check('homework: one card, the assignments rows of it', (await js(`document.querySelectorAll('main .card.stack > details').length`)) === 2);
check('homework: past its date and not done is marked, a coming one is not', JSON.stringify(await js(`[...document.querySelectorAll('main details')].map((d) => d.querySelector('summary .tag:not(.ok)')?.textContent ?? '')`)) === JSON.stringify(['', 'po terminie']));
await js(`document.querySelector('main details summary').click()`);
await sleep(100);
check('homework: html stripped, link rendered', (await js(`document.querySelector('main details .rich').innerText`)).includes('Opis postaci.') &&
  (await js(`document.querySelector('main details .rich a')?.href`)) === 'https://example.com/a');
check('homework: unread until opened, read one not marked', !(await js(`document.querySelector('main details').classList.contains('unread')`)) &&
  !(await js(`document.querySelectorAll('main details')[1].classList.contains('unread')`)));
const hwLog = (await log()).filter((l) => l.includes('HomeWorkAssignments/Mark'));
check('homework: opening sends MarkAsRead once', JSON.stringify(hwLog) === JSON.stringify(['POST /api/s/1001u/HomeWorkAssignments/MarkAsRead {"homework": 1}']), hwLog);
check('homework: attachment listed', JSON.stringify(await text('main details .files li')) === JSON.stringify(['karta.pdf']), await text('main details .files li'));
const hwFile = await openFile('karta.pdf');
check('homework: attachment opens the DownloadUrl', hwFile === 'https://files.example/1-3', hwFile);
await clickText('main details button', 'Oznacz jako wykonane');
await until(`!!document.querySelector('main details.done')`);
check('homework: mark done', (await log()).includes('POST /api/s/1001u/HomeWorkAssignments/MarkAsDone {"homework": 1}') &&
  (await text('main details summary .tag'))[0] === 'wykonane' && !(await js(`!!document.querySelectorAll('main details')[0].querySelector('button.secondary')`)));
await shot('7-homework');

await go('#/wiadomosci', `document.querySelectorAll('.messages li').length > 0`);
const inbox = await text('.messages .subject');
check('messages: a tab of its own, so no way back to the menu', (await text('nav.tabs a[aria-current=page]'))[0]?.endsWith('Wiadomości') && !(await js(`!!document.querySelector('main a.back')`)), await text('nav.tabs a[aria-current=page]'));
check('messages: inbox, trash excluded', JSON.stringify(inbox) === JSON.stringify(['Wycieczka', 'Stara']), inbox);
check('messages: unread marked', (await text('.messages li.unread .subject'))[0] === 'Wycieczka');
check('messages: sender on the first line, time in words with the date behind it', JSON.stringify(await text('.messages .who')) === JSON.stringify(['Anna Nowak', 'Piotr']) &&
  /godz\.|min|teraz/.test((await text('.messages time'))[0]) && /^\d+ \S+ \d{4}, 08:00$/.test(await js(`document.querySelector('.messages time').title`)), await text('.messages time'));
check('messages: user lookup chunked', (await log()).some((l) => /Messages\/User\/[\d,]+$/.test(l)));
await shot('8-messages');
const find = (q) => js(`(() => { const i = document.querySelector('main input.search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await find('piotr');
await sleep(50);
const found = await text('.messages .subject');
await find('nic takiego');
await sleep(50);
const none = await mainText();
await find('');
await sleep(50);
check('messages: search by sender or subject, and says when nothing matches', JSON.stringify(found) === JSON.stringify(['Stara']) &&
  none.includes('Brak wiadomości pasujących do wyszukiwania.') && (await text('.messages .subject')).length === 2, found);
await clickText('.segmented button', 'Wysłane');
await sleep(100);
const sent = await text('.messages li');
check('messages: sent folder', sent.length === 1 && sent[0].includes('Do: Anna Nowak'), sent);
await clickText('.segmented button', 'Odebrane');
await js(`document.querySelector('.messages a').click()`);
await until(`!!document.querySelector('main article')`);
const msg = await js(`document.querySelector('main article').innerText`);
check('message: detail, its subject the title under a way back to the list', (await text('main h1'))[0] === 'Wycieczka' && (await js(`document.querySelector('main a.back')?.compareDocumentPosition(document.querySelector('main h1')) === Node.DOCUMENT_POSITION_FOLLOWING`)) && msg.includes('Od: Anna Nowak') && msg.includes('Do: Jan Testowy') && msg.includes('załączniki'), msg);
check('message: body is text, nothing executed', (await js(`window.pwned === undefined && !document.querySelector('main img, main script') && !document.querySelector('main').innerText.includes('pwned')`)) &&
  (await js(`document.querySelector('main .rich a')?.href`)) === 'https://example.com/x');
await shot('9-message');
await clickText('main a', 'Wiadomości');
await until(`!document.querySelector('nav.tabs .badge')`);
check('messages: badge cleared after reading', !(await js(`!!document.querySelector('nav.tabs .badge')`)) && !(await js(`!!document.querySelector('.messages li.unread')`)));

const setField = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const submit = () => js(`document.querySelector('form.compose').requestSubmit()`);
await clickText('main a', 'Napisz');
await until(`document.querySelectorAll('.receivers details').length > 0`);
const sections = await text('.receivers summary');
check('compose: groups, subgroups flattened, parents skipped, failed group dropped',
  JSON.stringify(sections) === JSON.stringify(['Wychowawcy\n0 z 1', 'Nauczyciele: Matematyka\n0 z 2']) && !(await log()).some((l) => l.includes('ReceiversGroup/parents')), sections);
const subjectInput = '.compose > label:first-of-type input';
await setField(subjectInput, 'blad');
await setField('.compose textarea', 'Tresc');
await submit();
check('compose: recipient required', (await text('main [role=alert]'))[0] === 'Wybierz odbiorcę wiadomości.', await text('main [role=alert]'));
await setField('.receivers input[type=search]', 'piotr');
await sleep(100);
check('compose: search filters and opens', JSON.stringify(await text('.receivers details[open] .check')) === JSON.stringify(['Piotr Zielinski']), await text('.receivers details[open] .check'));
await js(`document.querySelector('.receivers .check input').click()`);
await setField('.receivers input[type=search]', '');
await sleep(100);
await js(`document.querySelector('.receivers details .check input').click()`);
check('compose: picked shown as removable pills', JSON.stringify(await text('.picked .pill')) === JSON.stringify(['Piotr Zielinski', 'Anna Nowak']), await text('.picked .pill'));
await submit();
await until(`!!document.querySelector('main [role=alert]')`);
check('compose: Librus error text shown', (await text('main [role=alert]'))[0] === 'Odbiorca nie przyjmuje wiadomości.', await text('main [role=alert]'));
await js(`document.querySelector('.receivers details').open = true`);
await shot('14-compose');
await setField(subjectInput, 'Pytanie o test');
// On a phone: Enter on the keyboard in the recipient search only closes the keyboard, it does not send.
const posts = async () => (await log()).filter((l) => l.startsWith('POST /api/s/1001u/Messages ')).length;
const postsBefore = await posts();
await js(`document.querySelector('.receivers input[type=search]').focus()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(300);
check('compose: Enter in the recipient search does not send', (await posts()) === postsBefore && (await js(`location.hash`)) === '#/wiadomosci/nowa' &&
  (await js(`document.activeElement.type !== 'search'`)));
// Writing, the form scrolled to its top: the send button is still on screen, the tabs out of the way, and a finger's tap sends.
await js(`document.querySelector('.compose textarea').focus(); scrollTo(0, 0)`);
const sendAt = await js(`(() => { const b = document.querySelector('.compose .send'); const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
  return { x, y, hit: document.elementFromPoint(x, y) === b, clear: r.bottom <= innerHeight, tabs: getComputedStyle(document.querySelector('.tabs')).display }; })()`);
check('compose: the send button stays in reach, no tabs while writing', sendAt.hit && sendAt.clear && sendAt.tabs === 'none', sendAt);
await shot('14-compose-send');
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sendAt.x, y: sendAt.y }] });
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await until(`location.hash === '#/wiadomosci/15' && !!document.querySelector('main article')`);
const sentLog = (await log()).filter((l) => l.startsWith('POST /api/s/1001u/Messages ')).at(-1);
check('compose: new message posted with receivers', sentLog === 'POST /api/s/1001u/Messages {"body": "Tresc", "receivers": ["2", "1"], "subject": "Pytanie o test"}', sentLog);
check('compose: opens sent message with confirmation, the tabs back', (await text('.toast'))[0] === 'Wiadomość wysłana.' && (await text('main h1'))[0] === 'Pytanie o test' &&
  (await js(`getComputedStyle(document.querySelector('.tabs')).display`)) !== 'none');

await go('#/wiadomosci/11', `!!document.querySelector('main article')`);
await clickText('main a', 'Odpowiedz');
await until(`!!document.querySelector('form.compose')`);
check('reply: recipient and subject prefilled', (await mainText()).includes('Do: Anna Nowak') && (await js(`document.querySelector('.compose label input').value`)) === 'Re: Wycieczka' && !(await js(`!!document.querySelector('.receivers')`)));
await setField('.compose textarea', 'Dziekuje');
await submit();
await until(`location.hash === '#/wiadomosci/15'`);
const replyLog = (await log()).filter((l) => l.startsWith('POST /api/s/1001u/Messages ')).at(-1);
check('reply: posted with originalMessageId, no receivers', replyLog === 'POST /api/s/1001u/Messages {"body": "Dziekuje", "originalMessageId": "11", "subject": "Re: Wycieczka"}', replyLog);

await go('#/wiadomosci/12', `!!document.querySelector('main article .files')`);
const files = await text('main article .files li');
check('message: attachments listed, unnamed one numbered', JSON.stringify(files) === JSON.stringify(['regulamin.pdf', 'Załącznik 2']) && !(await mainText()).includes('Pobierzesz je'), files);
const msgFile = await openFile('regulamin.pdf');
check('message: attachment opens the DownloadUrl', msgFile === 'https://files.example/12-5', msgFile);
const badFile = await openFile('Załącznik 2');
check('message: DownloadUrl that is not https is refused', badFile === 'closed' && (await text('main [role=alert]'))[0] === 'Librus nie odpowiada. Spróbuj później.', badFile);

await fetch(`${base}/__unread`);
await go('#/start', loaded);
await go('#/wiadomosci', `!!document.querySelector('.messages li.unread')`);
await clickText('main button', 'Oznacz jako przeczytane');
await until(`!document.querySelector('.messages li.unread') && !document.querySelector('nav.tabs .badge')`);
check('messages: mark all read', !(await js(`!!document.querySelector('.messages li.unread')`)) && !(await js(`!!document.querySelector('nav.tabs .badge')`)) &&
  !(await js(`[...document.querySelectorAll('main button')].some((b) => b.textContent.includes('Oznacz jako przeczytane'))`)));

await go('#/ogloszenia', `document.querySelectorAll('main details').length === 2`);
const notices = await text('main details summary');
check('notices: sorted, author, unknown author', notices[0].startsWith('Zebranie') && notices[0].includes('Anna Nowak') && notices[1].includes('Nieznany'), notices);

await go('#/uwagi', `document.querySelectorAll('main .note').length === 2`);
const notes = await text('main .note h2');
check('notes: categories (CategoryName fallback), type', JSON.stringify(notes) === JSON.stringify(['Konkursy pozytywna', 'Przygotowanie negatywna']), notes);
check('notes: the type is a tag, only a negative one in red', await js(`(() => { const t = [...document.querySelectorAll('main .note h2 .tag')]; return t.length === 2 && t[0].classList.contains('plain') && !t[1].classList.contains('plain') && document.querySelectorAll('main .note')[1].classList.contains('negatywna'); })()`));
await shot('10-notes');

await go('#/zachowanie', loaded);
const beh = await text('main .totals li');
check('behaviour: grades, points 403 ignored', JSON.stringify(beh) === JSON.stringify(['śródroczna\nbardzo dobre', 'Proponowana roczna\nwzorowe']) && !(await mainText()).includes('Punkty') && !(await js(`!!document.querySelector('main [role=alert]')`)), beh);

await go('#/nauczyciele', `document.querySelectorAll('main .totals').length === 2`);
const teachers = await text('main .totals li');
check('teachers: class, tutor and school, then subjects', JSON.stringify(teachers) === JSON.stringify([
  'Klasa\n2a', 'Wychowawca\nAnna Nowak', 'Szkoła\nSP nr 1', 'Adres\nSzkolna 5, Kraków', 'Język polski\nPiotr', 'Matematyka\nAnna Nowak, Piotr']), teachers);

// Librus down: a view never loaded says so with a way to try again, one loaded before keeps its data under a note.
await fetch(`${base}/__down`);
await go('#/tematy', `!!document.querySelector('main [role=alert]')`);
check('down: an error that can pass offers another try', (await text('main [role=alert] p'))[0] === 'Librus nie odpowiada. Spróbuj później.' && (await js(hasButton('Spróbuj ponownie'))), await mainText());
await go('#/ogloszenia', `!!document.querySelector('main .note-line')`);
check('down: data loaded before stays, with a note', (await js(`document.querySelectorAll('main details').length`)) === 2 && (await text('main .note-line p'))[0]?.startsWith('Nie udało się odświeżyć'), await mainText());
await fetch(`${base}/__up`);
await clickText('main button', 'Spróbuj ponownie');
check('down: trying again once Librus is back clears the note', await until(`!document.querySelector('main .note-line') && document.querySelectorAll('main details').length === 2`), await mainText());

await go('#/aktywnosc', `document.querySelectorAll('main .feed li').length === 6`);
check('activity: the whole list on its own page, each entry leading to its view', (await text('h1.title'))[0] === 'Aktywność' &&
  JSON.stringify(await js(`[...document.querySelectorAll('main .feed a')].map((a) => a.getAttribute('href'))`)) === JSON.stringify(['#/oceny', '#/frekwencja', '#/oceny', '#/plan', '#/wiadomosci/11', '#/uwagi']) &&
  (await log()).filter((l) => l === 'GET /api/activity/1001u').length >= 2);
// The sidebar is in the page (hidden on a phone) and names each view with its icon.
const feedIcons = await js(`[...document.querySelectorAll('main .feed a:has(.tile)')].map((a) => a.querySelector('.tile svg').innerHTML === document.querySelector('.side a[href="#/' + a.getAttribute('href').split('/')[1] + '"] svg')?.innerHTML)`);
check('activity: an entry without a grade shows the icon of its view, a removal struck through', JSON.stringify(feedIcons) === JSON.stringify([true, false, true, true, true]) &&
  (await js(`(() => { const a = document.querySelectorAll('main .feed a:has(.tile)')[1]; return a.textContent.includes('Usunięta') && a.querySelector('.tile svg').innerHTML.startsWith(document.querySelector('.side a[href="#/oceny"] svg').innerHTML); })()`)), feedIcons);
await shot('23-activity');

await go('#/tematy', `document.querySelectorAll('main section').length > 0`);
const topics = await rows('main section:first-of-type .events li');
check('topics: newest day first, lessons in order, subject and teacher via lesson', (await js(`document.querySelectorAll('main section').length`)) === 10 &&
  JSON.stringify(topics) === JSON.stringify(['Matematyka lekcja 1 · Anna Nowak Ułamki 1', 'Język polski lekcja 2 · Piotr Lektura']), topics);
await clickText('main button', 'Pokaż starsze');
await sleep(100);
check('topics: older days on demand', (await js(`document.querySelectorAll('main section').length`)) === 12 && !(await js(`!!document.querySelector('main button')`)));
await shot('15-topics');

// Headless Chromium has no push service, so the browser side is a stub: what is checked is what the app does with it.
await js(`(() => {${pushStub}})()`);
await go('#/powiadomienia', hasButton('Włącz powiadomienia'));
check('push: offered while this device is not subscribed', (await js(hasButton('Włącz powiadomienia'))) && !(await mainText()).includes('Włączone'), await mainText());
await clickText('main button', 'Włącz powiadomienia');
await until(`document.querySelectorAll('main .access li').length === 2`);
const pushLog = (await log()).filter((l) => l.includes('/api/push'));
check('push: subscribes with the server key and registers the device', (await js('window.__key')) === 65 && (await mainText()).includes('Włączone.') &&
  pushLog.includes('POST /api/push {"endpoint": "https://fcm.googleapis.com/fcm/send/e2e", "keys": {"auth": "a", "p256dh": "p"}}'), pushLog);
const feedRows = await rows('main .access li');
check('push: feed state per student', feedRows[0]?.startsWith('Jan Testowy Sprawdzono 9 lis 2025') && feedRows[1] === 'Ala Testowa Sesja Librusa wygasła. Zaloguj ponownie' &&
  (await js(`[...document.querySelectorAll('main .access li:nth-child(2) button')].map((b) => b.textContent.trim()).join()`)) === 'Zaloguj ponownie', feedRows);
const pushKinds = await js(`[...document.querySelectorAll('main label.check')].map((l) => (l.querySelector('input').checked ? '+' : '-') + l.textContent.trim())`);
check('push: kinds of message, as the server keeps them for this device', pushKinds.length === 11 && pushKinds[0] === "+Oceny" && pushKinds[9] === "+Szczęśliwy numerek" && pushKinds[10].startsWith("-Przerwy"), pushKinds);
await shot('17-push');
await clickText('main label.check', 'Szczęśliwy numerek');
await until(`fetch('/__log').then((r) => r.json()).then((l) => l.some((x) => x.startsWith('PUT /api/push')))`);
await until(`!document.querySelector('main label.check input').disabled`);
check('push: a kind turned off is saved for this device', (await log()).includes('PUT /api/push {"endpoint":"https://fcm.googleapis.com/fcm/send/e2e","off":["przerwy","numerek"]}') &&
  !(await js(`[...document.querySelectorAll('main label.check input')][9].checked`)), (await log()).filter((l) => l.includes('/api/push')));

await clickText('main button', 'Wyłącz');
await until(hasButton('Włącz powiadomienia'));
check('push: turning it off removes the device from the server and the browser', (await js('window.__sub')) === null &&
  (await log()).includes('DELETE /api/push {"endpoint":"https://fcm.googleapis.com/fcm/send/e2e"}'), (await log()).filter((l) => l.includes('/api/push')));

await go('#/dostep', `document.querySelectorAll('main .access li').length > 0`);
const access = await rows('main .access li');
check('access: added address with state, then fixed ones', access.length === 2 && access[0].startsWith('ala@example.com zalogowany · dodany') && access[1] === 'rodzic@example.com', access);
await setField('form.compose input', 'a@b');
await submit();
await until(`!!document.querySelector('main [role=alert]')`);
check('access: server refusal shown', (await text('main [role=alert]'))[0] === 'To nie wygląda na adres e-mail.', await text('main [role=alert]'));
await setField('form.compose input', 'Nowy@Example.com');
await submit();
await until(`document.querySelectorAll('main .access li').length === 3`);
const added = await rows('main .access li');
check('access: address added, form cleared', added[0]?.startsWith('nowy@example.com niezalogowany') && (await js(`document.querySelector('form.compose input').value`)) === '' &&
  !(await js(`!!document.querySelector('main [role=alert]')`)) && (await log()).includes('POST /api/admin/emails {"email": "Nowy@Example.com"}'), added);
await shot('16-access');
dialog.accept = false;
await js(`document.querySelector('main .access button').click()`);
await sleep(300);
check('access: removal asks first, cancel keeps the address', dialog.text.includes('nowy@example.com') && (await rows('main .access li')).length === 3 && !(await log()).some((l) => l.startsWith('DELETE /api/admin')), dialog.text);
dialog.accept = true;
await js(`document.querySelector('main .access button').click()`);
await until(`document.querySelectorAll('main .access li').length === 2`);
check('access: address removed', (await log()).includes('DELETE /api/admin/emails/nowy%40example.com') && !(await mainText()).includes('nowy@example.com'), await rows('main .access li'));

await fetch(`${base}/__admin`);
await send('Page.reload');
await until(`!!document.querySelector('header.bar select')`);
await go('#/dostep', `!!document.querySelector('.greeting')`);
await go('#/wiecej', `document.querySelectorAll('.menu a').length > 0`);
const plainMenu = await text('.menu a');
check('access: page and menu entry hidden from non-admins', plainMenu.length === 11 && !plainMenu.includes('Dostęp do aplikacji') && (await log()).filter((l) => l === 'GET /api/admin/emails').length === 1, plainMenu);

await go('#/wiecej', `document.querySelectorAll('.menu a').length > 0`);
await clickText('main button', 'Usuń moje dane');
await sleep(600);
check('delete my data: asked first, deleted on the server, back to login', dialog.text.startsWith('Usunąć z serwera') &&
  (await log()).includes('DELETE /api/me') && (await js(`!!document.querySelector('form.login')`)));
await fill('dobre');
await until(`!!document.querySelector('header.bar select')`);

await go('#/bogus', `!!document.querySelector('.greeting')`);
check('unknown route falls back to start', await js(`!!document.querySelector('.greeting')`));

await go('#/frekwencja', `document.querySelectorAll('main .totals').length === 2`);
await js(`(() => { const s = document.querySelector('header select'); s.value = '2002u'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(600);
const l2 = await log();
check('student switch refetches', l2.some((l) => l.startsWith('GET /api/s/2002u/Attendances')));
check('student remembered', (await js(`localStorage.getItem('student')`)) === '2002u');

// The second student's school also grades with points, words and descriptions, and the account has no Mobilne Dodatki.
await go('#/oceny', `[...document.querySelectorAll('main h2')].some((h) => h.textContent === 'Oceny opisowe')`);
const bySubject = `Object.fromEntries([...document.querySelectorAll('main section')].map((s) => [s.querySelector('h2').textContent, s.innerText.replace(/\\s+/g, ' ')]))`;
const pressed = () => js(`document.querySelector('main .segmented [aria-pressed=true]')?.textContent`);
const second = await js(bySubject);
check('grades: the second semester shown first once it has grades, with the descriptive grades of the whole year', (await pressed()) === 'II semestr' &&
  JSON.stringify(second) === JSON.stringify({ Matematyka: 'Matematyka Bieżące ZA B', 'Oceny opisowe': 'Oceny opisowe Opis UC' }), second);
const kinds = [];
const detailOf = async (chip) => {
  await clickText('.chip', chip);
  await sleep(100);
  kinds.push((await text('.detail'))[0]);
};
const plain = (values) => js(`${JSON.stringify(values)}.every((v) => [...document.querySelectorAll('.chip')].find((c) => c.textContent.trim() === v).classList.contains('g0'))`);
let uncoloured = await plain(['ZA', 'B', 'UC']);
await detailOf('ZA');
await detailOf('B');
await clickText('main .segmented button', 'I semestr');
await until(`document.querySelector('main .segmented [aria-pressed=true]')?.textContent === 'I semestr'`);
const first = await js(bySubject);
check('grades: every system lands under its subject, a grade flagged semestral gets its own line, in its semester', (await pressed()) === 'I semestr' &&
  /śr\. I sem\. 71,50 Bieżące 3 5\/20 Semestralna zw$/.test(first['Język polski']) && /Bieżące 5 4\+ Semestralna 5$/.test(first['Matematyka']) &&
  first['Oceny opisowe'] === 'Oceny opisowe Opis UC', first);
uncoloured &&= await plain(['5/20']);
await detailOf('5/20');
await detailOf('UC');
const [za, b, points, uc] = kinds;
check('grades: points with their range and comment, word and descriptive grades in full', JSON.stringify([points, za, b, uc]) === JSON.stringify([
  'Sprawdzian, 0–20 pkt\n20 paź · Anna Nowak\nBrawo', 'Bez kategorii\n21 paź · Piotr\nzaliczono',
  'Czytanie\n22 paź · Anna Nowak\nCzyta płynnie', 'Ocena śródroczna\n23 paź · Anna Nowak\nUczeń pracuje wytrwale.']), [points, za, b, uc]);
check('grades: only the 1 to 6 scale is coloured', uncoloured);
const probes = (await log()).filter((l) => /^GET \/api\/s\/1001u\/(PointGrades|TextGrades|DescriptiveGrades|DescriptiveTextGrades|DescriptiveGrades\/Text)$/.test(l));
check('grades: a system the school does not use is not asked about on every visit', probes.length === 10, probes);
await shot('18-grades-systems');

await go('#/zadania', `!!document.querySelector('main [role=alert]')`);
check('premium: a refused paid module is explained once Librus confirms there is no subscription', (await text('main [role=alert]'))[0]?.includes('Mobilnymi Dodatkami') &&
  (await log()).includes('GET /api/s/2002u/Me'), await text('main [role=alert]'));

// Messages of that account come from the Synergia website instead.
check('webmail: unread badge read from the website', (await text('nav.tabs .badge'))[0] === '1', await text('nav.tabs .badge'));
await go('#/wiadomosci', `document.querySelectorAll('.messages li').length === 2`);
const webInbox = await js(`[...document.querySelectorAll('.messages li')].map((li) => [li.querySelector('.who').textContent, li.querySelector('.subject').textContent, li.querySelector('time').title])`);
check('webmail: received folder, unread one marked', JSON.stringify(webInbox) === JSON.stringify([['Nowak Anna (nauczyciel)', 'Zebranie', '9 lis 2026, 08:15'], ['Zieliński Piotr', 'Regulamin', '2 lis 2026, 10:00']]) &&
  JSON.stringify(await text('.messages li.unread .subject')) === JSON.stringify(['Zebranie']), webInbox);
check('webmail: writing is offered like on any account', await js(`[...document.querySelectorAll('main a')].some((a) => a.textContent.trim() === 'Napisz')`));
await clickText('.segmented button', 'Wysłane');
await until(`document.querySelectorAll('.messages li').length === 1`);
check('webmail: sent folder loaded on demand', (await rows('.messages li'))[0]?.startsWith('Do: Nowak Anna (nauczyciel) Pytanie o wycieczkę ') && (await js(`document.querySelector('.messages time').title`)) === '3 lis 2026, 17:30' && (await log()).filter((l) => l === 'GET /api/w/2002u/wiadomosci/6').length === 1, await rows('.messages li'));
await js(`document.querySelector('.messages a').click()`);
await until(`!!document.querySelector('main article')`);
check('webmail: sent message lists its recipients', (await mainText()).includes('Do: Nowak Anna (nauczyciel)') && !(await mainText()).includes('Od:') && (await mainText()).includes('Czy wycieczka jest aktualna?'), await mainText());
await go('#/wiadomosci/5-301', `!!document.querySelector('main article')`);
const webMsg = await js(`document.querySelector('main article').innerText`);
check('webmail: message read from the page', (await text('main h1'))[0] === 'Zebranie' && webMsg.includes('Od: Nowak Anna (nauczyciel)') && webMsg.includes('9 lis 2026, 08:15') && webMsg.includes('zebranie we wtorek'), webMsg);
check('webmail: page content is text, nothing in it runs', (await js(`window.pwned === undefined && !document.querySelector('main img, main script')`)) &&
  (await js(`document.querySelector('main .rich a')?.href`)) === 'https://example.com/z');
check('webmail: opening a message clears the badge', await until(`!document.querySelector('nav.tabs .badge')`));
await go('#/wiadomosci/5-300', `!!document.querySelector('main article .files')`);
const webFile = await openFile('regulamin.pdf');
check('webmail: attachment opens the link the site hands out', webFile === 'https://sandbox.librus.pl/GetFile/key' && (await log()).includes('GET /api/w/2002u/wiadomosci/pobierz_zalacznik/300/9'), webFile);
await shot('19-webmail');

// Writing on that account fills in the site's own form.
const posted = async (prefix) => JSON.parse((await log()).filter((l) => l.startsWith(prefix)).at(-1)?.slice(prefix.length) ?? 'null');
await go('#/wiadomosci/6-400', `!!document.querySelector('main article')`);
check('webmail: a sent message has no reply form on the site, so none is offered', !(await js(`[...document.querySelectorAll('main a')].some((a) => a.textContent.trim() === 'Odpowiedz')`)));
await go('#/wiadomosci/nowa', `document.querySelectorAll('.receivers details').length > 0`);
const webSections = await text('.receivers summary');
check('webmail compose: the groups the site offers, parents and empty groups left out',
  JSON.stringify(webSections) === JSON.stringify(['Wychowawcy\n0 z 1', 'Nauczyciele\n0 z 2']) && !(await log()).some((l) => l.includes('rada_rodzicow')), webSections);
await setField(subjectInput, 'blad');
await setField('.compose textarea', 'Czy zebranie jest o 17?');
await js(`document.querySelectorAll('.receivers details').forEach((d) => d.querySelector('.check input').click())`);
await submit();
await until(`!!document.querySelector('main [role=alert]')`);
check('webmail compose: one group per message, as on the site', (await text('main [role=alert]'))[0]?.includes('z jednej grupy') &&
  !(await log()).some((l) => l.startsWith('POST /api/w/2002u/wiadomosci')), await text('main [role=alert]'));
await js(`document.querySelector('.picked .pill').click()`);
await submit();
await until(`(document.querySelector('main [role=alert]')?.textContent ?? '').includes('nie potwierdził')`);
check('webmail compose: a form the site turns down is not reported as sent', (await text('main [role=alert]'))[0]?.includes('nie potwierdził') && (await js(`location.hash`)) === '#/wiadomosci/nowa', await text('main [role=alert]'));
await shot('24-webmail-compose');
await setField(subjectInput, 'Pytanie o zebranie');
await submit();
await until(`location.hash === '#/wiadomosci/6-401' && !!document.querySelector('main article')`);
const webNew = await posted('POST /api/w/2002u/wiadomosci/5 ');
check('webmail compose: the form goes out with its hidden fields and the whole group list', JSON.stringify(webNew) === JSON.stringify([
  ['requestkey', 'KEY-NEW'], ['filtrUzytkownikow', '0'], ['idPojemnika', ''], ['Rodzaj', '0'], ['poprzednia', '5'], ['fileStorageIdentifier', ''],
  ['adresat', 'nauczyciel'], ['DoKogo[]', '1000001'], ['DoKogo_hid[]', '1000001'], ['DoKogo_hid[]', '1000002'],
  ['temat', 'Pytanie o zebranie'], ['tresc', 'Czy zebranie jest o 17?'], ['wyslij', 'Wyślij']]), webNew);
check('webmail compose: opens the message found in the sent folder', (await text('.toast'))[0] === 'Wiadomość wysłana.' &&
  (await text('main h1'))[0] === 'Pytanie o zebranie' && (await mainText()).includes('Do: Nowak Anna'), await mainText());
await go('#/wiadomosci/5-301', `!!document.querySelector('main article')`);
await clickText('main a', 'Odpowiedz');
await until(`!!document.querySelector('form.compose')`);
check('webmail reply: recipient and subject prefilled', (await mainText()).includes('Do: Nowak Anna (nauczyciel)') &&
  (await js(`document.querySelector('.compose label input').value`)) === 'Re: Zebranie' && !(await js(`!!document.querySelector('.receivers')`)));
await setField('.compose textarea', 'Będę.');
await submit();
await until(`location.hash === '#/wiadomosci/6-402' && !!document.querySelector('main article')`);
const webReply = await posted('POST /api/w/2002u/wiadomosci ');
check('webmail reply: the reply form goes out as the site built it', JSON.stringify(webReply) === JSON.stringify([
  ['requestkey', 'KEY-REPLY'], ['filtrUzytkownikow', '0'], ['idPojemnika', ''], ['poprzednia', '5'], ['DoKogo', '1000001'], ['Wid', '301'],
  ['idWiadomosciOrg', '301'], ['idOdpowiadajacego', '0'], ['typ', 'odp'], ['fileStorageIdentifier', ''],
  ['temat', 'Re: Zebranie'], ['tresc', 'Będę.'], ['wyslij', 'Wyślij']]), webReply);
check('webmail reply: opens the sent reply', (await text('.toast'))[0] === 'Wiadomość wysłana.' && (await text('main h1'))[0] === 'Re: Zebranie');
await go('#/zachowanie', `document.querySelectorAll('main .entries li').length === 2`);
const behaviour = [(await text('main section:last-of-type h2'))[0], ...(await rows('main .entries li'))];
check('behaviour: symbol entries, category range and comment, no total that would be partial', JSON.stringify(behaviour) === JSON.stringify([
  'Punkty i wpisy', '5 Konkurs, 5 pkt12 paź · Anna Nowak', 'WC Wagary, od -10 do -5 pkt5 paź · Anna Nowak · Dwie godziny']), behaviour);

await go('#/uwagi', `!!document.querySelector('main [role=alert]')`);
check('errors: any other refusal quotes Librus', (await text('main [role=alert]'))[0] === 'Szkoła nie udostępnia tego modułu. Librus: „Brak dostępu.”', await text('main [role=alert]'));

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await go('#/start', `document.querySelectorAll('main .events li').length > 0 && ${loaded}`);
await shot('11-start-dark');
await go('#/wiadomosci', `document.querySelectorAll('.messages li').length > 0`);
await shot('12-messages-dark');
await send('Emulation.setEmulatedMedia', { features: [] });

// A wide screen: the bar and the tabs give way to a labelled sidebar. Both students get one name for this part.
await fetch(`${base}/__twins`);
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
// A desktop with a mouse: fine pointer, so the denser sidebar rows apply.
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
// The tour again, as a first start on a computer would have it, where the browser offers to install the app and
// notifications can be turned on: both stubbed from the page's first line, before the app listens.
await js(`localStorage.removeItem('tour-seen')`);
const { identifier: stubs } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `${pushStub}
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, ...rest) {
    add.call(this, type, fn, ...rest);
    if (type === 'beforeinstallprompt') queueMicrotask(() => { const e = new Event(type, { cancelable: true }); e.prompt = () => (window.__asked = true); e.userChoice = Promise.resolve({ outcome: 'accepted' }); fn(e); });
  };` });
await send('Page.reload');
await until(`!!document.querySelector('.side .nav-row[aria-current=page]')`);
await until(`document.querySelector('dialog.tour')?.open === true`);
let installed = false, subscribed = false;
const deskTour = await walkTour({ 'Reszta dziennika': '20-desktop-tour', 'Zainstaluj aplikację': '20-desktop-tour-install' }, {
  'Zainstaluj aplikację': async () => {
    await clickText('dialog.tour button', 'Zainstaluj aplikację');
    installed = (await until('window.__asked === true')) && (await until(`![...document.querySelectorAll('dialog.tour button')].some((b) => b.textContent.trim() === 'Zainstaluj aplikację')`));
  },
  Powiadomienia: async () => {
    await clickText('dialog.tour button', 'Włącz powiadomienia');
    subscribed = (await until(`document.querySelector('dialog.tour')?.innerText.includes('Włączone.')`)) &&
      (await log()).includes('POST /api/push {"endpoint": "https://fcm.googleapis.com/fcm/send/e2e", "keys": {"auth": "a", "p256dh": "p"}}');
    await shot('20-desktop-tour-push');
  },
});
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubs });
const deskTitles = deskTour.map((t) => t.title);
check('tour (desktop): the sidebar instead of the tabs, the bug report, then installing and notifications',
  JSON.stringify(deskTitles) === JSON.stringify(['Witaj w Dzienniku', 'Start', 'Oceny', 'Plan', 'Wiadomości', 'Reszta dziennika', 'Uczeń', 'Odświeżanie', 'Zgłoś błąd', 'Zainstaluj aplikację', 'Powiadomienia']), deskTitles);
check('tour: installs the app on the browser\'s offer', installed);
check('tour: turns notifications on, the device registered with the server', subscribed, (await log()).filter((l) => l.includes('/api/push')));
check('tour (desktop): each card on screen and off the part it is about', deskTour.every((t) => t.apart && t.inside), deskTour.filter((t) => !t.apart || !t.inside));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
check('tour: Esc closes it for good as well', await until(`!document.querySelector('dialog.tour') && localStorage.getItem('tour-seen') === '1'`));
await send('Page.reload');
await until(`!!document.querySelector('.side .nav-row[aria-current=page]')`);
check('tour: not again after a reload', !(await js(`!!document.querySelector('dialog.tour')`)));
await go('#/start', `document.querySelectorAll('main .events li').length > 0 && ${loaded}`);
const displayed = (sel) => js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display !== 'none'`);
check('desktop: a sidebar replaces the bar and the tabs', (await displayed('.side')) && !(await displayed('.bar')) && !(await displayed('.tabs')));
await until(`document.querySelectorAll('.side .account small').length === 2`);
const twins = await rows('.side .account');
check('desktop: accounts with one name are told apart, a pupil from a parent', JSON.stringify(twins) === JSON.stringify(['JT Jan Testowyuczeń', 'JT Jan Testowyrodzic']) &&
  (await js(`document.querySelectorAll('.side .account[aria-pressed=true]').length`)) === 1, twins);
check('phone: the picker carries the same hint', JSON.stringify(await js(`[...document.querySelectorAll('.bar option')].map((o) => o.textContent)`)) === JSON.stringify(['Jan Testowy · uczeń', 'Jan Testowy · rodzic']));
check('desktop: start page lays its panels out in two columns', await js(`(() => { const [a, b] = document.querySelectorAll('.panels > .col'); return a.getBoundingClientRect().top === b.getBoundingClientRect().top && document.documentElement.scrollWidth <= innerWidth; })()`));
await shot('20-desktop-start');
check('desktop: a long e-mail ends in an ellipsis, the bug report and logout stay in the sidebar', await js(`(() => { const s = document.querySelector('.side'), small = s.querySelector('.me small'), was = small.textContent; small.textContent = 'bardzo.dlugi.adres.rodzica.ucznia@example.com'; const fits = s.scrollWidth <= s.clientWidth && small.scrollWidth > small.clientWidth; small.textContent = was; return fits && !!s.querySelector('.me a[aria-label="Zgłoś błąd"][href*="/issues/new?template=bug.yml"]'); })()`));
await go('#/terminarz', `document.querySelectorAll('.soon li').length === 3 && ${loaded}`);
check('desktop calendar: the month and its tiles beside the list', await js(`(() => { const [a, b] = document.querySelectorAll('.panels > .col'); return a.getBoundingClientRect().right <= b.getBoundingClientRect().left; })()`));
await shot('21-desktop-calendar');
await go('#/plan', loaded);
await clickText('.segmented button', 'Tydzień');
await until(`document.querySelectorAll('.week .column').length === 5 && !!document.querySelector('.week .tag.exam')`);
await shot('21-desktop-plan');
if (weekday) {
  const pin = async (time) => {
    await js(`Date.prototype.toTimeString = () => '${time}:00 GMT+0100'`);
    await js(`document.querySelector('header button[aria-label=Odśwież], .side button[aria-label=Odśwież]').click()`);
    await sleep(100);
    await until(`!document.querySelector('.busy')`);
  };
  await pin('08:20');
  const tag = await js(`(() => { const t = document.querySelector('.week li.current .time'), line = document.querySelector('.week .column .now'); return t && { text: t.textContent, line: !!line && Math.round(line.getBoundingClientRect().top - t.closest('button').getBoundingClientRect().top) }; })()`);
  check('desktop plan: the lesson in progress counts down, a line across today at the time, under the lessons', tag?.text === 'do końca 25 min' && Math.abs(tag.line - 20 * 1.6) <= 3 &&
    (await js(`document.querySelector('.week .column .now') === document.querySelector('.week .column .now').parentNode.firstElementChild`)), tag);
  await shot('21-desktop-plan-now');
  await pin('07:30');
}
await clickText('.side .nav-row .grow', 'Oceny');
await until(`document.querySelector('h1.title')?.textContent === 'Oceny' && ${loaded}`);
check('desktop: the sidebar navigates and marks the place', (await text('.side .nav-row[aria-current=page]'))[0] === 'Oceny');
await shot('21-desktop-grades');
await js(`document.querySelector('.sheet h2').textContent = 'administrowanie systemami operacyjnymi'; document.querySelector('.sheet .chip').click()`);
await until(`!!document.querySelector('.sheet .detail')`);
const longName = await js(`(() => { const s = document.querySelector('.sheet section'); const r = (q) => s.querySelector(q).getBoundingClientRect();
  return { gap: Math.round(r('.detail').top - r('.chips').bottom), nameBottom: Math.round(r('h2').bottom), detailTop: Math.round(r('.detail').top) }; })()`);
check('desktop grades: an opened grade sits under its chips, not under a subject name that wraps', longName.gap <= 12 && longName.nameBottom > longName.detailTop, longName);
await shot('21-desktop-grades-long');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await go('#/aktywnosc', loaded);
await go('#/terminarz', `document.querySelectorAll('.soon li').length === 3 && ${loaded}`);
await shot('22-desktop-calendar-dark');
await go('#/plan', `document.querySelectorAll('.week .column').length === 5 && !!document.querySelector('.week .tag.exam')`);
await shot('22-desktop-plan-dark');
await go('#/start', `document.querySelectorAll('main .events li').length > 0 && ${loaded}`);
await shot('22-desktop-start-dark');
await send('Emulation.setEmulatedMedia', { features: [] });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true });

await go('#/oceny', `document.querySelectorAll('main h2').length > 0`);
check('service worker active', await js(`navigator.serviceWorker.ready.then((r) => !!r.active)`));
// Headless Chromium grants no notification permission, so only the last step, showNotification, is replaced:
// the push event is a real one, delivered by the browser to the real handler.
await send('ServiceWorker.enable');
const worker = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker');
const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
const inWorker = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
await inWorker(`self.registration.showNotification = async (title, options) => { self.__shown = [title, options.body, options.data.url]; }`);
await until('true', 300);
await send('ServiceWorker.deliverPushMessage', { origin: base, registrationId: swRegistration, data: JSON.stringify({ title: 'Jan Testowy', body: 'Nowe: oceny', url: '/#/frekwencja' }) });
let shown;
for (const end = Date.now() + 3000; Date.now() < end && !shown; await sleep(50)) shown = await inWorker('self.__shown');
check('push: the service worker turns a delivered message into a notification', JSON.stringify(shown) === JSON.stringify(['Jan Testowy', 'Nowe: oceny', '/#/frekwencja']), shown ?? null);
await send('Target.detachFromTarget', { sessionId });
await js(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { url: location.origin + '/#/frekwencja' } }))`);
check('push: a tapped notification opens its view', await until(`document.querySelector('h1.title')?.textContent === 'Frekwencja'`));
await go('#/oceny', `document.querySelectorAll('main h2').length > 0`);
await send('Page.reload');
await sleep(1000);
check('page controlled by SW after reload', await js(`!!navigator.serviceWorker.controller`));
const apiCached = await js(`caches.open('api-v1').then((c) => c.keys()).then((k) => k.length)`);
check('api responses cached (bounded)', apiCached > 0 && apiCached <= 120, apiCached);

// A link where every answer takes 10 s: opening the app again shows the last data from the service worker's copies
// (PATIENCE in sw.js), not a blank page until the network answers twice. What a phone saves going to the background first.
await go('#/', `document.querySelectorAll('main section li').length > 0 && !document.querySelector('.busy')`);
await js(`Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange'))`);
await sleep(300);
await fetch(`${base}/__slow`);
const opened = Date.now();
send('Page.navigate', { url: base + '/' }).catch(() => {});
const early = await until(`document.querySelectorAll('main section li').length > 0`, 8000);
check('slow link: opening again shows the last data within seconds, the network still on its way', early && !!(await js(`document.querySelector('.busy')`)), Date.now() - opened);
await fetch(`${base}/__fast`);
await until(`!document.querySelector('.busy')`, 30000);
await go('#/oceny', `document.querySelectorAll('main h2').length > 0`);

// A new build on the server: another index.html, and sw.js stamped anew. Put back right after.
const dist = new URL('../dist/', import.meta.url);
const [html0, worker0] = await Promise.all([readFile(new URL('index.html', dist), 'utf8'), readFile(new URL('sw.js', dist), 'utf8')]);
const entry = html0.match(/\/assets\/index-[^"]+\.js/)[0];
await copyFile(new URL(`.${entry}`, dist), new URL('assets/index-next.js', dist));
await writeFile(new URL('index.html', dist), html0.replace(entry, '/assets/index-next.js'));
await writeFile(new URL('sw.js', dist), worker0 + '// build next\n');
check('update: nothing offered while the build is current', !(await js(`!!document.querySelector('.banner button')`)));
await js(`document.dispatchEvent(new Event('visibilitychange'))`);
const offered = await until(`document.querySelector('.banner[role=status] button')?.textContent === 'Zaktualizuj'`, 8000);
check('update: coming back to the app finds the new build and offers it', offered, await text('.banner'));
await shot('25-update');
await js(`window.__old = true`);
await js(`document.dispatchEvent(new Event('visibilitychange'))`);
const reloaded = await until(`!window.__old && !!document.querySelector('script[src="/assets/index-next.js"]') && document.querySelectorAll('main h2').length > 0`, 8000);
check('update: and the next time it switches to it by itself', reloaded && !(await js(`!!document.querySelector('.banner button')`)));
await Promise.all([writeFile(new URL('index.html', dist), html0), writeFile(new URL('sw.js', dist), worker0), rm(new URL('assets/index-next.js', dist))]);

// The user agent is read once, on load: Android is told about at the end, where reloads count no requests.
const where = await js('location.hash');
await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
await send('Page.reload');
await go('#/wiecej', `document.querySelectorAll('.menu a').length > 0`);
check('install: on Android the app points to Chrome for installing', await until(`document.querySelector('main').innerText.includes('Najlepiej zainstaluj Dziennik z\u00a0Google Chrome.')`));
await send('Emulation.setUserAgentOverride', { userAgent: '' });
await js(`location.hash = ${JSON.stringify(where)}`);
await send('Page.reload');
await until(`document.querySelectorAll('main h2').length > 0`);

await send('Network.enable');
process.kill(Number(mockPid));
await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await send('Page.reload');
await until(`[...document.querySelectorAll('main h2')].some((h) => h.textContent === 'Matematyka')`);
check('offline: app shell + cached data', (await text('main h2')).includes('Matematyka'), await text('main h2'));
check('offline banner', (await text('.banner'))[0]?.startsWith('Offline'), await text('.banner'));
await shot('13-offline');
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await js(`dispatchEvent(new Event('online'))`);

await go('#/wiecej', `document.querySelectorAll('.menu a').length > 0`);
await clickText('main button', 'Wyloguj');
await sleep(600);
check('logout returns to login', await js(`!!document.querySelector('form.login')`));
check('api cache cleared on logout', !(await js(`caches.has('api-v1')`)));

const expected = (p) => p.startsWith('log: Failed to load resource');
console.log('network errors (401 login, 403/404 soft modules, offline phase):\n' + problems.filter(expected).join('\n'));
const real = problems.filter((p) => !expected(p));
console.log(real.length ? 'PROBLEMS:\n' + real.join('\n') : 'no console errors/exceptions');
ws.close();
