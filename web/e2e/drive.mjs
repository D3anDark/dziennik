import { writeFile } from 'node:fs/promises';

const [, , cdpPort, out, base, mockPid] = process.argv;
const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let seq = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    problems.push('exception: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    problems.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
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

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
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
check('start is default page', (await text('h1.title'))[0] === 'Start');
check('lucky number', (await text('.lucky'))[0] === 'Numerek 13', await text('.lucky'));
const start = await mainText();
check('start: unread link', start.includes('Nieprzeczytane wiadomości: 1'), start);
check('start: badge on Więcej', (await text('nav.tabs .badge'))[0] === '1', await text('nav.tabs .badge'));
const firstH2 = (await text('main section h2'))[0];
check('start: next lesson day', (await js(`[0,6].includes(new Date().getDay())`)) ? firstH2 !== 'Dziś' : firstH2 === 'Dziś', firstH2);
check('start: lessons listed', start.includes('Matematyka') && start.includes('sala 104'), start);
const recent = await text('main .entries li .chip');
check('start: recent grades newest first', recent[0] === '4+' && recent.length === 6, recent);
const ev = await text('main .events li strong');
check('start: 14-day events, far ones excluded',
  ev.includes('Sprawdzian: Matematyka') && ev.includes('Nieobecność nauczyciela: Piotr') && ev.includes('Wycieczka klasowa') && !ev.includes('Wywiadowka'), ev);
await shot('1-start');

await go('#/oceny', `document.querySelectorAll('main h2').length > 0`);
const subjects = await text('main h2');
check('grades: subjects sorted, unknown ids not merged', JSON.stringify(subjects) === JSON.stringify(['Inne', 'Inne', 'Język polski', 'Matematyka']), subjects);
check('tab current', (await text('nav.tabs a[aria-current=page]'))[0] === 'Oceny');
const mat = await js(`[...document.querySelectorAll('main section')].find((s) => s.querySelector('h2').textContent === 'Matematyka').innerText`);
check('grades: semestral split, average shown, zero averages hidden', mat.includes('Ocena semestralna: 5') && mat.includes('Średnia: I sem. 4.67') && !mat.includes('II sem. 0'), mat);
await clickText('.chip', '4+');
await sleep(100);
const det = (await text('.detail'))[0] ?? '';
check('grades: detail with weight and teacher', det.startsWith('Kartkówka, ') && det.endsWith('waga 2, Anna Nowak'), det);
await shot('2-grades');

await go('#/plan', `document.querySelectorAll('main section').length === 7`);
const firstDay = await js(`document.querySelector('main section').innerText`);
check('plan: 7 days, sorted, room symbol', /1\s+08:00–08:45\s+Matematyka/.test(firstDay) && firstDay.includes('sala 104') && firstDay.indexOf('Fizyka') < firstDay.indexOf('Język polski'), firstDay);
check('plan: canceled lesson tagged', (await js(`document.querySelectorAll('li.canceled').length`)) === 1);
check('plan: this week disabled', await js(`[...document.querySelectorAll('.weeknav button')][1].disabled`));
await shot('3-plan');
const before = (await log()).filter((l) => l.includes('Timetables')).length;
await clickText('.weeknav button', 'Następny');
await sleep(600);
check('plan: next week requested', (await log()).filter((l) => l.includes('Timetables')).length === before + 1);

await go('#/frekwencja', `document.querySelectorAll('main .totals').length === 2`);
const totals = await text('main section:nth-of-type(1) .totals li');
check('attendance: percentage and counts', JSON.stringify(totals) === JSON.stringify(['Frekwencja\n60.0%', 'Nieobecność\n2', 'Spóźnienie\n1']), totals);
const per = await text('main section:nth-of-type(2) .totals li');
check('attendance: per subject', JSON.stringify(per) === JSON.stringify(['Inne\n1 nb, 66.7%', 'Matematyka\n1 nb, 50.0%']), per);
check('attendance: presence filtered', (await js(`document.querySelectorAll('.entries li').length`)) === 3);
await shot('4-attendance');

await go('#/wiecej', `document.querySelectorAll('.menu a').length > 0`);
const menu = await text('.menu a');
check('more: menu', menu.length === 7 && menu.includes('Wiadomości\n1'), menu);
check('more: tab current', (await text('nav.tabs a[aria-current=page]'))[0]?.endsWith('Więcej'));
await shot('5-more');

await go('#/terminarz', `document.querySelectorAll('main .events li').length > 0`);
const cal = await text('main .events li strong');
check('calendar: month events incl. single-key HomeWork', cal.includes('Sprawdzian: Matematyka') && cal.includes('Wycieczka klasowa'), cal);
check('calendar: range end shown', (await mainText()).includes('do '));
check('more tab current on subpage', (await text('nav.tabs a[aria-current=page]'))[0]?.endsWith('Więcej'));
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
await clickText('main details button', 'Oznacz jako wykonane');
await until(`!!document.querySelector('main details.done')`);
check('homework: mark done', (await log()).includes('POST /api/s/1001u/HomeWorkAssignments/MarkAsDone {"homework": 1}') &&
  (await text('main details summary .tag'))[0] === 'wykonane' && !(await js(`!!document.querySelectorAll('main details')[0].querySelector('button')`)));
await shot('7-homework');

await go('#/wiadomosci', `document.querySelectorAll('.messages li').length > 0`);
const inbox = await text('.messages .subject');
check('messages: inbox, trash excluded', JSON.stringify(inbox) === JSON.stringify(['Wycieczka', 'Stara']), inbox);
check('messages: unread marked', (await text('.messages li.unread .subject'))[0] === 'Wycieczka');
check('messages: sender names', (await text('.messages small'))[1]?.startsWith('Piotr,'), await text('.messages small'));
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

await go('#/nauczyciele', `document.querySelectorAll('main .totals li').length > 0`);
const teachers = await text('main .totals li');
check('teachers', JSON.stringify(teachers) === JSON.stringify(['Język polski\nPiotr', 'Matematyka\nAnna Nowak, Piotr']), teachers);

await go('#/bogus', `document.querySelector('h1.title')?.textContent === 'Start'`);
check('unknown route falls back to start', (await text('h1.title'))[0] === 'Start');

await go('#/frekwencja', `document.querySelectorAll('main .totals').length === 2`);
await js(`(() => { const s = document.querySelector('header select'); s.value = '2002u'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(600);
const l2 = await log();
check('student switch refetches', l2.some((l) => l.startsWith('GET /api/s/2002u/Attendances')) && l2.some((l) => l.startsWith('GET /api/s/2002u/LuckyNumbers')));
check('student remembered', (await js(`localStorage.getItem('student')`)) === '2002u');

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await go('#/start', `document.querySelectorAll('main .events li').length > 0 && ${loaded}`);
await shot('11-start-dark');
await go('#/wiadomosci', `document.querySelectorAll('.messages li').length > 0`);
await shot('12-messages-dark');
await send('Emulation.setEmulatedMedia', { features: [] });

await go('#/oceny', `document.querySelectorAll('main h2').length > 0`);
check('service worker active', await js(`navigator.serviceWorker.ready.then((r) => !!r.active)`));
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

await js(`document.querySelector('header button[aria-label=Wyloguj]').click()`);
await sleep(600);
check('logout returns to login', await js(`!!document.querySelector('form.login')`));
check('api cache cleared on logout', !(await js(`caches.has('api-v1')`)));

const expected = (p) => p.startsWith('log: Failed to load resource');
console.log('network errors (401 login, 403/404 soft modules, offline phase):\n' + problems.filter(expected).join('\n'));
const real = problems.filter((p) => !expected(p));
console.log(real.length ? 'PROBLEMS:\n' + real.join('\n') : 'no console errors/exceptions');
ws.close();
