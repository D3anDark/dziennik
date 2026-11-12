// Smoke test of the demo build (dist-demo/) as GitHub Pages serves it, under a subpath: every view on a phone and a
// wide screen loads with no error, no console problem and something in it. Run by e2e/demo.sh.
import { writeFile } from 'node:fs/promises';

const [, , cdpPort, out, base] = process.argv;
const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) pending.get(msg.id)?.(msg);
  else if (msg.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) problems.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
const until = async (expr, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await js(expr)) return true;
  return false;
};
const check = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + JSON.stringify(detail) : ''}`);
const loaded = `!!document.querySelector('main') && !document.querySelector('main').innerText.includes('Ładowanie')`;

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
const VIEWS = ['start', 'oceny', 'plan', 'frekwencja', 'wiadomosci', 'terminarz', 'aktywnosc', 'zadania', 'tematy', 'ogloszenia', 'uwagi', 'zachowanie', 'nauczyciele', 'powiadomienia', 'ustawienia', 'dostep'];
for (const [size, width, height, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 800, false]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await send('Page.navigate', { url: `${base}/#/start` });
  check(`${size}: opens signed in, the demo said so`, await until(`${loaded} && document.querySelector('.banner')?.innerText.startsWith('Wersja demo:')`));
  if (size === 'phone') {
    check('the tour opens on the first start', await until(`document.querySelector('dialog.tour')?.open === true`));
    await js(`[...document.querySelectorAll('dialog.tour button')].find((b) => b.textContent === 'Pomiń').click()`);
    check('the tour is skipped for good', await until(`!document.querySelector('dialog.tour') && localStorage.getItem('tour-seen') === '1'`));
  }
  for (const view of VIEWS) {
    await js(`location.hash = '#/${view}'`);
    const ok = await until(`${loaded} && document.querySelector('main').innerText.trim().length > 40`);
    await sleep(150);
    const alert = await js(`document.querySelector('main [role=alert], main .error')?.innerText ?? ''`);
    check(`${size}: ${view} shows data`, ok && !alert && !(await js(`[...document.querySelectorAll('main p.center.muted')].some((p) => p.innerText.startsWith('Brak'))`)), alert);
    if (size === 'phone' || ['start', 'oceny', 'plan', 'terminarz'].includes(view)) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(`${out}/demo-${size}-${view}.png`, Buffer.from(data, 'base64'));
    }
  }
  if (size === 'desktop') {
    // A row more would push the sidebar's foot off a 1280×800 screen: the settings are an icon in that foot.
    const icon = `document.querySelector('.side .me a[href="#/ustawienia"]')`;
    await js(`${icon}?.click()`);
    check('desktop: the settings are an icon in the foot of the sidebar, not one more row', (await js(`!document.querySelector('.side nav a[href="#/ustawienia"]')`)) &&
      (await until(`${icon}?.getAttribute('aria-current') === 'page' && document.querySelector('main h1')?.textContent === 'Ustawienia'`)));
  }
}

await js(`location.hash = '#/start'`);
check('start: the day shown has a substitution', await until(`document.querySelector('main .lessons')?.innerText.includes('zastępstwo')`));

// What a visitor does: opens a message, writes one, marks homework done, opens an attachment link.
await js(`location.hash = '#/wiadomosci'`);
await until(`document.querySelectorAll('.messages li').length > 0`);
const unreadBefore = await js(`document.querySelectorAll('.messages .unread').length`);
await js(`document.querySelector('.messages .unread a').click()`);
check('message opens with its text and attachment', await until(`document.querySelector('main').innerText.includes('zgody') && !!document.querySelector('.files button')`));
await js(`location.hash = '#/wiadomosci'`);
await until(`document.querySelectorAll('.messages li').length > 0`);
check('an opened message is no longer unread', unreadBefore === 2 && (await until(`document.querySelectorAll('.messages .unread').length === 1`)), unreadBefore);
await js(`location.hash = '#/start'`);
await js(`document.querySelector('.side .account:not([aria-pressed=true])').click()`);
check('the second child has data of its own', await until(`${loaded} && document.querySelector('main').innerText.includes('Ostatnie oceny') && document.querySelector('.side .account[aria-pressed=true]').innerText.includes('Antoni')`));
const attachment = await js(`fetch('zalacznik.pdf').then((r) => r.ok && r.headers.get('content-type'))`);
check('the attachment file is served next to the app', String(attachment).includes('pdf'), attachment);

await js(`location.hash = '#/terminarz'`);
await until(`${loaded} && document.querySelectorAll('main .events li').length > 0`);
const dayCards = `document.querySelectorAll('main .swipe section').length`;
const moreButton = `[...document.querySelectorAll('main button')].find((b) => b.textContent === 'Pokaż więcej')`;
const first = await js(`[${dayCards}, !!${moreButton}]`);
check('calendar: the list shows three days and offers the rest', first[0] === 3 && first[1], first);
await js(`${moreButton}.click()`);
check('calendar: every day once asked, the button gone', await until(`${dayCards} > 3 && !${moreButton}`));
await js(`document.querySelector('.pager button[aria-label="Następny miesiąc"]').click()`);
await until(loaded);
await js(`document.querySelector('.pager button[aria-label="Poprzedni miesiąc"]').click()`);
check('calendar: another month and back starts short again', await until(`${loaded} && ${dayCards} === 3 && !!${moreButton}`), await js(dayCards));

// Another day of the school year, picked in the banner: in March a subject has both semesters and the first one's grade.
await js(`location.hash = '#/oceny'`);
await until(loaded);
const now = new Date();
const march = `${now.getFullYear() - (now.getMonth() < 8) + 1}-03-16`;
await js(`(() => { const s = document.querySelector('.banner select'); s.value = '${march}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const moved = await until(`location.search === '?dzien=${march}' && location.hash === '#/oceny' && ${loaded} && !!document.querySelector('main .sheet')`);
const subject = `document.querySelector('main .sheet section')?.innerText.replace(/\\s+/g, ' ')`;
const pressed = `document.querySelector('main .segmented [aria-pressed=true]')?.textContent`;
const second = await js(subject);
check('demo: a day picked in the banner moves the clock, March opens on the second semester', moved && (await js(`new Date().getMonth() === 2 && new Date().getDate() === 16`)) &&
  (await js(`document.querySelector('.banner select').value`)) === march && (await js(pressed)) === 'II semestr' && /II sem\. .* Bieżące /.test(second) && !second.includes('Semestralna'), second);
await js(`[...document.querySelectorAll('main .segmented button')].find((b) => b.textContent === 'I semestr').click()`);
await until(`${pressed} === 'I semestr'`);
const firstTerm = await js(subject);
check('demo: the first semester, its grades and its final grade', /śr\. I sem\. \S+ Bieżące .* Semestralna \S+$/.test(firstTerm) && !firstTerm.includes('II sem.'), firstTerm);
const { data: marchShot } = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(`${out}/demo-desktop-oceny-marzec.png`, Buffer.from(marchShot, 'base64'));

// The third child goes to a school graded otherwise, seen in that March: points out of a category's maximum with the
// share of them, percents with their mean, letters, words, the pupil described as a whole, no averages from Librus and a kind of attendance of
// the school's own.
await js(`[...document.querySelectorAll('.side .account')].find((b) => b.innerText.includes('Maja')).click()`);
const row = (name) => `([...document.querySelectorAll('main .sheet section')].find((x) => x.innerText.startsWith('${name}'))?.innerText ?? '').replace(/\\s+/g, ' ')`;
await until(`${loaded} && document.querySelector('.side .account[aria-pressed=true]').innerText.includes('Maja') && ${row('Matematyka')}.includes('/30')`);
const third = await js(`[${['Matematyka', 'Technika', 'Wychowanie fizyczne', 'Oceny opisowe', 'Język polski', 'Informatyka', 'Przyroda'].map(row)}, document.querySelector('main').innerText]`);
check('third child: points with their share, letters, words, the pupil described, averages the app counts', /śr\. II sem\. [\d,]+%/.test(third[0]) &&
  / [ABC]( |$)/.test(third[1]) && / ZA( |$)/.test(third[2]) && third[3].startsWith('Oceny opisowe') && third[7].includes('Średnie wylicza aplikacja'), third.slice(0, 4));
check('third child: grades in percent, and their mean in percent', /^Przyroda śr\. II sem\. [\d,]+%.* Bieżące( \d+%)+/.test(third[6]), third[6]);
check('third child: an improved grade shows with its improvement', third[4].includes('poprawiona na'), third[4]);
const { data: thirdShot } = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(`${out}/demo-desktop-oceny-punkty.png`, Buffer.from(thirdShot, 'base64'));
// 1 to 6 grades kept as descriptive ones: an average only once asked for in the settings.
const forcedBox = `[...document.querySelectorAll('main label.check')].find((l) => l.textContent.trim() === 'Licz średnie z każdej oceny 1–6')?.querySelector('input')`;
await js(`location.hash = '#/ustawienia'`);
await until(`${forcedBox}?.checked === false`);
await js(`${forcedBox}.click()`);
await js(`location.hash = '#/oceny'`);
check('third child: descriptive 1 to 6 grades count once the settings say so', !third[5].includes('śr.') && (await until(`${loaded} && ${row('Informatyka')}.includes('śr.')`)), [third[5], await js(row('Informatyka'))]);
await js(`location.hash = '#/frekwencja'`);
check("third child: the school's own kind of attendance", await until(`${loaded} && document.querySelector('main').innerText.includes('Zwolnienie na zawody')`));

// The link preview (vite.config.js) is read from the page as it is served, with no script run: there, one Container
// within Discord's 3000 bytes, and every picture it names a file of the site.
const html = await (await fetch(`${base}/`)).text();
const card = html.match(/<script id="discord:component-embed" type="application\/json">(.*?)<\/script>/s)?.[1] ?? '';
const site = html.match(/<meta property="og:url" content="([^"]+)"/)?.[1] ?? '';
const pictures = [...new Set([...html.matchAll(/https:\/\/[^"\\]+\.png/g)].map((m) => m[0]))];
const served = await Promise.all(pictures.map(async (u) => u.startsWith(site) && (await fetch(`${base}/${u.slice(site.length)}`)).headers.get('content-type') === 'image/png'));
check('demo: the link preview is in the served page, one Container within 3000 bytes, its pictures on the site', JSON.parse(card || '{}').component?.type === 17 &&
  Buffer.byteLength(card) <= 3000 && pictures.length === 3 && served.every(Boolean) && html.includes('<meta name="twitter:card" content="summary_large_image">'), { bytes: Buffer.byteLength(card), pictures, served });

check('no console errors/exceptions', problems.length === 0, problems);
process.exit(0);
