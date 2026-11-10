import { writeFile } from 'node:fs/promises';

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
await fill('zle');
await sleep(400);
const alert = await text('[role=alert]');
check('bad password message', alert[0] === 'Nieprawidłowy e-mail lub hasło.', alert);

await fill('dobre');
await until(`!!document.querySelector('header.bar select')`);
await until(`document.querySelectorAll('main .events li').length > 0 && ${loaded}`);
const greeting = await text('.greeting > *');
check('start is default page, opened by a greeting with the date, the student and the lucky number', ['Dzień dobry', 'Dobry wieczór'].includes(greeting[0]) && / · Jan Testowy · szczęśliwy numerek 13$/.test(greeting[1]) && !(await js(`!!document.querySelector('h1.title')`)), greeting);
const start = await mainText();
const weekday = !(await js(`[0,6].includes(new Date().getDay())`));
const friday = (await js(`new Date().getDay()`)) === 5;
const tiles = await rows('.tiles li');
check('start: count tiles', tiles.length === 4 && tiles[0] === 'Nieprzeczytane 1 wiadomości' && tiles[1].startsWith(weekday ? 'Lekcje dziś ' : 'Najbliższe lekcje ') && tiles[2] === 'Nowe oceny 0 z ostatnich 7 dni' && tiles[3] === 'Terminarz 3 w ciągu 14 dni' &&
  (await js(`document.querySelector('.tiles a').getAttribute('href')`)) === '#/wiadomosci', tiles);
const feed = await rows('.panels .feed li');
check('start: activity shows edits and removals, a changed grade with its value, unknown kinds left out', feed.length === 5 && /^4\+ Zmieniona ocenaMatematyka \d+ min$/.test(feed[0]) && feed[1].startsWith('Nowy wpis we frekwencji ') &&
  feed[2].startsWith('Usunięta ocena ') && feed[3].startsWith('Zmiana w planie lekcji ') && feed[4].startsWith('Nowa wiadomość '), feed);
check('start: unread count on the messages tab', JSON.stringify(await text('nav.tabs a[href="#/wiadomosci"] .badge')) === '["1"]' && (await text('nav.tabs .badge')).length === 1, await text('nav.tabs .badge'));
const firstH2 = (await text('main section h2'))[0];
check('start: next lesson day', (await js(`[0,6].includes(new Date().getDay())`)) ? firstH2 !== 'Dziś' : firstH2 === 'Dziś', firstH2);
check('start: lessons listed', start.includes('Matematyka') && start.includes('sala 104'), start);
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
  check('start: lesson in progress, then the next one, nothing after school', marks[0].length === 1 && /Matematyka.*teraz/.test(marks[0][0]) && marks[1].length === 1 && /Fizyka.*następna/.test(marks[1][0]) && marks[2].length === 0, marks);
  const after = [(await text('.panels .card h2'))[0], (await rows('.tiles li'))[1], await js(`document.querySelector('.panels .card').classList.contains('today')`)];
  check('start: after the last lesson the plan and its tile move to the next school day', !after[2] &&
    (friday ? /^poniedziałek, /.test(after[0]) && /^Najbliższe lekcje 3 poniedziałek, od 08:00$/.test(after[1]) : after[0] === 'Jutro' && /^Lekcje jutro [23] od 08:00$/.test(after[1])), after);
  await at('07:30');
}

await go('#/oceny', `document.querySelectorAll('main h2').length > 0`);
const subjects = await text('main h2');
check('grades: subjects sorted, unknown ids not merged', JSON.stringify(subjects) === JSON.stringify(['Inne', 'Inne', 'Język polski', 'Matematyka']), subjects);
check('tab current', (await text('nav.tabs a[aria-current=page]'))[0] === 'Oceny');
const mat = await js(`[...document.querySelectorAll('main section')].find((s) => s.querySelector('h2').textContent === 'Matematyka').innerText`);
check('grades: semestral split, average at the subject, zero averages hidden', mat.includes('Ocena semestralna: 5') && mat.includes('śr. I sem. 4.67') && !mat.includes('II sem. 0'), mat);
await clickText('.chip', '4+');
await sleep(100);
const det = (await text('.detail'))[0] ?? '';
check('grades: detail with weight and teacher', det.startsWith('Kartkówka, ') && det.endsWith('waga 2, Anna Nowak'), det);
await shot('2-grades');

await go('#/plan', `document.querySelectorAll('main section').length === 7`);
const firstDay = await js(`document.querySelector('main section').innerText`);
check('plan: 7 days, sorted, room symbol', /1\s+08:00–08:45\s+Matematyka/.test(firstDay) && firstDay.includes('sala 104') && firstDay.indexOf('Fizyka') < firstDay.indexOf('Język polski'), firstDay);
check('plan: canceled lesson tagged', (await js(`document.querySelectorAll('li.canceled').length`)) === 1);
const changed = await text('.lessons .change');
check('plan: substitution names what it replaced, with the note', JSON.stringify(changed) === JSON.stringify(['zamiast: Język polski, Piotr; Przynieście zeszyty']), changed);
check('plan: this week disabled', !weekday || (await js(`[...document.querySelectorAll('.weeknav button')][1].disabled`)));
await shot('3-plan');
if (weekday) {
  const place = await js(`(() => { const top = document.querySelector('.card.today').getBoundingClientRect().top; return { top, first: document.querySelector('main section').classList.contains('today'), end: scrollY + innerHeight >= document.documentElement.scrollHeight - 2 }; })()`);
  check('plan: opens at today', place.first || (place.top >= 60 && place.top <= 90) || place.end, place);
  // After school the same view opens at the next school day; on a Friday that is the week after.
  await js(`Date.prototype.toTimeString = () => '23:00:00 GMT+0100'`);
  await go('#/start', loaded);
  await go('#/plan', `document.querySelectorAll('main section').length === 7`);
  await sleep(200);
  const later = await js(`(() => { const cards = [...document.querySelectorAll('main section')]; const today = cards.findIndex((c) => c.classList.contains('today')); const top = (i) => cards[i]?.getBoundingClientRect().top;
    return { today, next: top(today + 1), thisWeek: [...document.querySelectorAll('.weeknav button')][1].disabled, end: scrollY + innerHeight >= document.documentElement.scrollHeight - 2 }; })()`);
  check('plan: after the last lesson it opens at the next school day', friday ? later.today === -1 && !later.thisWeek : later.thisWeek && ((later.next >= 60 && later.next <= 90) || later.end), later);
  await js(`Date.prototype.toTimeString = () => '07:30:00 GMT+0100'`);
  await go('#/start', loaded);
  await go('#/plan', `document.querySelectorAll('main section').length === 7`);
}
const before = (await log()).filter((l) => l.includes('Timetables')).length;
await clickText('.weeknav button', 'Następny');
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

await go('#/frekwencja', `document.querySelectorAll('main .totals').length === 2`);
const totals = await text('main section:nth-of-type(1) .totals li');
check('attendance: percentage and counts', JSON.stringify(totals) === JSON.stringify(['Frekwencja\n60.0%', 'Nieobecność\n2', 'Spóźnienie\n1']), totals);
const per = await text('main section:nth-of-type(2) .totals li');
check('attendance: per subject', JSON.stringify(per) === JSON.stringify(['Inne\n1 nb, 66.7%', 'Matematyka\n1 nb, 50.0%']), per);
check('attendance: presence filtered', (await js(`document.querySelectorAll('.entries li').length`)) === 3);
await shot('4-attendance');

await go('#/wiecej', `document.querySelectorAll('.menu a').length > 0`);
const menu = await text('.menu a');
check('more: menu', menu.length === 11 && menu[0] === 'Frekwencja' && menu.includes('Aktywność') && !menu.some((m) => m.startsWith('Wiadomości')) && menu.includes('Tematy lekcji') && menu.includes('Powiadomienia') && menu.includes('Dostęp do aplikacji'), menu);
check('more: tab current', (await text('nav.tabs a[aria-current=page]'))[0]?.endsWith('Więcej'));
check('install: no button until the browser offers the app', !(await js(hasButton('Zainstaluj aplikację'))));
await js(`(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => (window.__asked = true); e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.__prevented = !dispatchEvent(e); })()`);
await until(hasButton('Zainstaluj aplikację'));
await clickText('main button', 'Zainstaluj aplikację');
await until(`!${hasButton('Zainstaluj aplikację')}`);
check('install: the offer is held back, asked on the button, and the button goes once answered', (await js(`window.__prevented && window.__asked === true`)) && !(await js(hasButton('Zainstaluj aplikację'))));
check('more: account and logout live here', (await mainText()).includes('Zalogowano jako rodzic@example.com') && (await js(hasButton('Wyloguj'))));
await shot('5-more');

await go('#/terminarz', `document.querySelectorAll('main .events li').length > 0`);
const cal = await text('main .events li strong');
check('calendar: month events incl. single-key HomeWork', cal.includes('Sprawdzian: Matematyka') && cal.includes('Wycieczka klasowa'), cal);
check('calendar: range end shown', (await mainText()).includes('do '));
check('more tab current on subpage', (await text('nav.tabs a[aria-current=page]'))[0]?.endsWith('Więcej'));
check('subpage: a way back to the menu', (await js(`document.querySelector('main a.back')?.getAttribute('href')`)) === '#/wiecej' && (await text('main a.back'))[0] === 'Więcej');
await shot('6-calendar');
await clickText('.weeknav button', 'Następny');
await until(loaded);
const m2 = new Date(); m2.setMonth(m2.getMonth() + 1, 1);
check('calendar: next month requested', (await log()).some((l) => l.includes(`Calendars/7?month=${m2.getMonth() + 1}&year=${m2.getFullYear()}`)));

await go('#/zadania', `document.querySelectorAll('main details').length === 2`);
const hw = await text('main details summary');
check('homework: sorted by due, subject via lesson', hw[0].startsWith('Wypracowanie') && hw[0].includes('Język polski') && hw[0].includes('termin'), hw);
check('homework: upcoming highlighted', await js(`document.querySelector('main details').classList.contains('today') && !document.querySelectorAll('main details')[1].classList.contains('today')`));
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
await clickText('.segmented button', 'Wysłane');
await sleep(100);
const sent = await text('.messages li');
check('messages: sent folder', sent.length === 1 && sent[0].includes('Do: Anna Nowak'), sent);
await clickText('.segmented button', 'Odebrane');
await js(`document.querySelector('.messages a').click()`);
await until(`!!document.querySelector('main article h2')`);
const msg = await js(`document.querySelector('main article').innerText`);
check('message: detail', msg.startsWith('Wycieczka') && msg.includes('Od: Anna Nowak') && msg.includes('Do: Jan Testowy') && msg.includes('załączniki'), msg);
check('message: body is text, nothing executed', (await js(`window.pwned === undefined && !document.querySelector('main img, main script') && !document.querySelector('main').innerText.includes('pwned')`)) &&
  (await js(`document.querySelector('main .rich a')?.href`)) === 'https://example.com/x');
await shot('9-message');
await clickText('main a', 'Wróć do listy');
await until(`!document.querySelector('nav.tabs .badge')`);
check('messages: badge cleared after reading', !(await js(`!!document.querySelector('nav.tabs .badge')`)) && !(await js(`!!document.querySelector('.messages li.unread')`)));

const setField = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const submit = () => js(`document.querySelector('form.compose').requestSubmit()`);
await clickText('main a', 'Napisz');
await until(`document.querySelectorAll('.receivers details').length > 0`);
const sections = await text('.receivers summary');
check('compose: groups, subgroups flattened, parents skipped, failed group dropped',
  JSON.stringify(sections) === JSON.stringify(['Wychowawcy\n1', 'Nauczyciele: Matematyka\n2']) && !(await log()).some((l) => l.includes('ReceiversGroup/parents')), sections);
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
await submit();
await until(`location.hash === '#/wiadomosci/15' && !!document.querySelector('main article h2')`);
const sentLog = (await log()).filter((l) => l.startsWith('POST /api/s/1001u/Messages ')).at(-1);
check('compose: new message posted with receivers', sentLog === 'POST /api/s/1001u/Messages {"body": "Tresc", "receivers": ["2", "1"], "subject": "Pytanie o test"}', sentLog);
check('compose: opens sent message with confirmation', (await text('.toast'))[0] === 'Wiadomość wysłana.' && (await text('main article h2'))[0] === 'Pytanie o test');

await go('#/wiadomosci/11', `!!document.querySelector('main article h2')`);
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
await clickText('main button', 'Oznacz wszystkie jako przeczytane');
await until(`!document.querySelector('.messages li.unread') && !document.querySelector('nav.tabs .badge')`);
check('messages: mark all read', !(await js(`!!document.querySelector('.messages li.unread')`)) && !(await js(`!!document.querySelector('nav.tabs .badge')`)) &&
  !(await js(`[...document.querySelectorAll('main button')].some((b) => b.textContent.includes('Oznacz wszystkie'))`)));

await go('#/ogloszenia', `document.querySelectorAll('main details').length === 2`);
const notices = await text('main details summary');
check('notices: sorted, author, unknown author', notices[0].startsWith('Zebranie') && notices[0].includes('Anna Nowak') && notices[1].includes('Nieznany'), notices);

await go('#/uwagi', `document.querySelectorAll('main .note').length === 2`);
const notes = await text('main .note h2');
check('notes: categories (CategoryName fallback), type', JSON.stringify(notes) === JSON.stringify(['Konkursy, pozytywna', 'Przygotowanie, negatywna']), notes);
check('notes: negative styled', await js(`document.querySelectorAll('main .note')[1].classList.contains('negatywna')`));
await shot('10-notes');

await go('#/zachowanie', loaded);
const beh = await text('main .totals li');
check('behaviour: grades, points 403 ignored', JSON.stringify(beh) === JSON.stringify(['śródroczna\nbardzo dobre', 'Proponowana roczna\nwzorowe']) && !(await mainText()).includes('Punkty') && !(await js(`!!document.querySelector('main [role=alert]')`)), beh);

await go('#/nauczyciele', `document.querySelectorAll('main .totals').length === 2`);
const teachers = await text('main .totals li');
check('teachers: class, tutor and school, then subjects', JSON.stringify(teachers) === JSON.stringify([
  'Klasa\n2a', 'Wychowawca\nAnna Nowak', 'Szkoła\nSP nr 1', 'Adres\nSzkolna 5, Kraków', 'Język polski\nPiotr', 'Matematyka\nAnna Nowak, Piotr']), teachers);

await go('#/aktywnosc', `document.querySelectorAll('main .feed li').length === 6`);
check('activity: the whole list on its own page, each entry leading to its view', (await text('h1.title'))[0] === 'Aktywność' &&
  JSON.stringify(await js(`[...document.querySelectorAll('main .feed a')].map((a) => a.getAttribute('href'))`)) === JSON.stringify(['#/oceny', '#/frekwencja', '#/oceny', '#/plan', '#/wiadomosci', '#/uwagi']) &&
  (await log()).filter((l) => l === 'GET /api/activity/1001u').length >= 2);
await shot('23-activity');

await go('#/tematy', `document.querySelectorAll('main section').length > 0`);
const topics = await rows('main section:first-of-type .events li');
check('topics: newest day first, lessons in order, subject and teacher via lesson', (await js(`document.querySelectorAll('main section').length`)) === 10 &&
  JSON.stringify(topics) === JSON.stringify(['Matematyka lekcja 1, Anna Nowak Ułamki 1', 'Język polski lekcja 2, Piotr Lektura']), topics);
await clickText('main button', 'Pokaż starsze');
await sleep(100);
check('topics: older days on demand', (await js(`document.querySelectorAll('main section').length`)) === 12 && !(await js(`!!document.querySelector('main button')`)));
await shot('15-topics');

// Headless Chromium has no push service, so the browser side is a stub: what is checked is what the app does with it.
await js(`(() => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e', options: {}, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, async unsubscribe() { window.__sub = null; return true; } };
  PushManager.prototype.subscribe = async function (options) { window.__key = new Uint8Array(options.applicationServerKey).length; return (window.__sub = sub); };
  PushManager.prototype.getSubscription = async () => window.__sub ?? null;
  Notification.requestPermission = async () => 'granted';
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
})()`);
await go('#/powiadomienia', hasButton('Włącz powiadomienia'));
check('push: offered while this device is not subscribed', (await js(hasButton('Włącz powiadomienia'))) && !(await mainText()).includes('Włączone'), await mainText());
await clickText('main button', 'Włącz powiadomienia');
await until(`document.querySelectorAll('main .access li').length === 2`);
const pushLog = (await log()).filter((l) => l.includes('/api/push'));
check('push: subscribes with the server key and registers the device', (await js('window.__key')) === 65 && (await mainText()).includes('Włączone na tym urządzeniu.') &&
  pushLog.includes('POST /api/push {"endpoint": "https://fcm.googleapis.com/fcm/send/e2e", "keys": {"auth": "a", "p256dh": "p"}}'), pushLog);
const feedRows = await rows('main .access li');
check('push: feed state per student', feedRows[0]?.startsWith('Jan Testowy Sprawdzono 9 lis 2025') && feedRows[1] === 'Ala Testowa Sesja Librusa wygasła. Zaloguj się ponownie.', feedRows);
await shot('17-push');
await clickText('main button', 'Wyłącz na tym urządzeniu');
await until(hasButton('Włącz powiadomienia'));
check('push: turning it off removes the device from the server and the browser', (await js('window.__sub')) === null &&
  (await log()).includes('DELETE /api/push {"endpoint":"https://fcm.googleapis.com/fcm/send/e2e"}'), (await log()).filter((l) => l.includes('/api/push')));

await go('#/dostep', `document.querySelectorAll('main .access li').length > 0`);
const access = await rows('main .access li');
check('access: added address with state, then fixed ones', access.length === 2 && access[0].startsWith('ala@example.com zalogowany, dodany') && access[1] === 'rodzic@example.com', access);
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
check('access: page and menu entry hidden from non-admins', plainMenu.length === 10 && !plainMenu.includes('Dostęp do aplikacji') && (await log()).filter((l) => l === 'GET /api/admin/emails').length === 1, plainMenu);

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
const bySubject = Object.fromEntries(await js(`[...document.querySelectorAll('main section')].map((s) => [s.querySelector('h2').textContent, s.innerText.replace(/\\s+/g, ' ')])`));
check('grades: every system lands under its subject, a grade flagged semestral gets its own line', /śr\. I sem\. 71\.50 I sem\. 3 5 Ocena semestralna: zwolniony/.test(bySubject['Język polski']) && bySubject['Matematyka']?.includes('II sem. ZA B') &&
  bySubject['Oceny opisowe'] === 'Oceny opisowe Opis UC', bySubject);
const detailOf = async (chip) => {
  await clickText('.chip', chip);
  await sleep(100);
  return (await text('.detail'))[0];
};
const kinds = [await detailOf('5'), await detailOf('ZA'), await detailOf('B'), await detailOf('UC')];
check('grades: points with their range and comment, word and descriptive grades in full', JSON.stringify(kinds) === JSON.stringify([
  'Sprawdzian, 0–20 pkt, 20 paź 2026, Anna Nowak\nBrawo', 'Bez kategorii, 21 paź 2026, Piotr\nzaliczono',
  'Czytanie, 22 paź 2026, Anna Nowak\nCzyta płynnie', 'Ocena śródroczna, 23 paź 2026, Anna Nowak\nUczeń pracuje wytrwale.']), kinds);
check('grades: only the 1 to 6 scale is coloured', await js(`['5', 'ZA', 'B', 'UC'].every((v) => [...document.querySelectorAll('.chip')].find((c) => c.textContent.trim() === v).classList.contains('g0'))`));
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
check('webmail: reading only, and the screen says so', (await mainText()).includes('czytane ze strony Synergii') && !(await js(`[...document.querySelectorAll('main a')].some((a) => a.textContent.trim() === 'Napisz')`)));
await clickText('.segmented button', 'Wysłane');
await until(`document.querySelectorAll('.messages li').length === 1`);
check('webmail: sent folder loaded on demand', (await rows('.messages li'))[0]?.startsWith('Do: Nowak Anna (nauczyciel) Pytanie o wycieczkę ') && (await js(`document.querySelector('.messages time').title`)) === '3 lis 2026, 17:30' && (await log()).filter((l) => l === 'GET /api/w/2002u/wiadomosci/6').length === 1, await rows('.messages li'));
await js(`document.querySelector('.messages a').click()`);
await until(`!!document.querySelector('main article h2')`);
check('webmail: sent message lists its recipients', (await mainText()).includes('Do: Nowak Anna (nauczyciel)') && !(await mainText()).includes('Od:') && (await mainText()).includes('Czy wycieczka jest aktualna?'), await mainText());
await go('#/wiadomosci/5-301', `!!document.querySelector('main article h2')`);
const webMsg = await js(`document.querySelector('main article').innerText`);
check('webmail: message read from the page', webMsg.startsWith('Zebranie') && webMsg.includes('Od: Nowak Anna (nauczyciel)') && webMsg.includes('9 lis 2026, 08:15') && webMsg.includes('zebranie we wtorek'), webMsg);
check('webmail: page content is text, nothing in it runs', (await js(`window.pwned === undefined && !document.querySelector('main img, main script')`)) &&
  (await js(`document.querySelector('main .rich a')?.href`)) === 'https://example.com/z' && !(await js(`[...document.querySelectorAll('main a')].some((a) => a.textContent.trim() === 'Odpowiedz')`)));
check('webmail: opening a message clears the badge', await until(`!document.querySelector('nav.tabs .badge')`));
await go('#/wiadomosci/5-300', `!!document.querySelector('main article .files')`);
const webFile = await openFile('regulamin.pdf');
check('webmail: attachment opens the link the site hands out', webFile === 'https://sandbox.librus.pl/GetFile/key' && (await log()).includes('GET /api/w/2002u/wiadomosci/pobierz_zalacznik/300/9'), webFile);
await shot('19-webmail');
await go('#/zachowanie', `document.querySelectorAll('main .entries li').length === 2`);
const behaviour = [(await text('main section:last-of-type h2'))[0], ...(await rows('main .entries li'))];
check('behaviour: symbol entries, category range and comment, no total that would be partial', JSON.stringify(behaviour) === JSON.stringify([
  'Punkty i wpisy', '5 Konkurs, 5 pkt12 paź 2026, Anna Nowak', 'WC Wagary, od -10 do -5 pkt5 paź 2026, Anna Nowak, Dwie godziny']), behaviour);

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
await send('Page.reload');
await until(`!!document.querySelector('.side .nav-row[aria-current=page]')`);
await go('#/start', `document.querySelectorAll('main .events li').length > 0 && ${loaded}`);
const displayed = (sel) => js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display !== 'none'`);
check('desktop: a sidebar replaces the bar and the tabs', (await displayed('.side')) && !(await displayed('.bar')) && !(await displayed('.tabs')));
await until(`document.querySelectorAll('.side .account small').length === 2`);
const twins = await rows('.side .account');
check('desktop: accounts with one name are told apart, a pupil from a parent', JSON.stringify(twins) === JSON.stringify(['JT Jan Testowyuczeń', 'JT Jan Testowyrodzic']) &&
  (await js(`document.querySelectorAll('.side .account[aria-pressed=true]').length`)) === 1, twins);
check('phone: the picker carries the same hint', JSON.stringify(await js(`[...document.querySelectorAll('.bar option')].map((o) => o.textContent)`)) === JSON.stringify(['Jan Testowy · uczeń', 'Jan Testowy · rodzic']));
check('desktop: start page lays its panels out in two columns', await js(`(() => { const [a, b] = document.querySelectorAll('.panels > .card'); return a.getBoundingClientRect().top === b.getBoundingClientRect().top && document.documentElement.scrollWidth <= innerWidth; })()`));
await shot('20-desktop-start');
await clickText('.side .nav-row .grow', 'Oceny');
await until(`document.querySelector('h1.title')?.textContent === 'Oceny' && ${loaded}`);
check('desktop: the sidebar navigates and marks the place', (await text('.side .nav-row[aria-current=page]'))[0] === 'Oceny');
await shot('21-desktop-grades');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await go('#/aktywnosc', loaded);
await go('#/start', `document.querySelectorAll('main .events li').length > 0 && ${loaded}`);
await shot('22-desktop-start-dark');
await send('Emulation.setEmulatedMedia', { features: [] });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

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
