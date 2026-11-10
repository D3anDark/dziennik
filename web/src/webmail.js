import { api, inbox, refreshUnread as countByApi } from './api.svelte.js';
import { plain } from './util.js';

/**
 * Messages read from the Synergia website, for accounts the API refuses (no Mobilne Dodatki). The server passes
 * each page on as a string and it is parsed here in an inert document: nothing in it runs or loads.
 * Selectors follow the site's markup as of November 2026.
 */
const FOLDER = { in: 5, out: 6 };
// shortcut: the count is read again at most this often, shorten it if the badge turns out to lag too much.
const EVERY = 5 * 60 * 1000;
// Students whose messages come from the website, and when their unread count was last read. Per page load.
const students = new Set();
const counted = new Map();

export const viaWeb = (login) => students.has(login);
export const useWeb = (login) => students.add(login);

const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** "2026-11-09 12:34:56", school-local, as the unix seconds the API dates are in. */
function unix(s) {
  const m = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s);
  return m ? new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6]).getTime() / 1000 : 0;
}

async function page(login, path) {
  const doc = new DOMParser().parseFromString((await api(`w/${encodeURIComponent(login)}/${path}`)).html, 'text/html');
  // Every page of the module lists the folders, "odebrane (3)" included, so the badge is updated for free.
  const received = doc.querySelector(`a[href="/wiadomosci/${FOLDER.in}"]`);
  if (received && inbox.login === login) {
    inbox.unread = Number(/\((\d+)\)/.exec(received.textContent)?.[1]) || 0;
    counted.set(login, Date.now());
  }
  return doc;
}

// shortcut: the first page of a folder only. The pager was not there to read (30 messages on the account this
// was built against); add it once a longer folder shows what it looks like.
/** One folder ('in' or 'out') as the rows Messages.svelte lists. */
export async function folder(login, name) {
  const n = FOLDER[name];
  const doc = await page(login, `wiadomosci/${n}`);
  return [...doc.querySelectorAll('table.decorated.stretch tbody tr')].flatMap((tr) => {
    const [, , who, title, date] = tr.children;
    const id = /\/wiadomosci\/1\/\d\/(\d+)\//.exec(title?.querySelector('a')?.getAttribute('href') ?? '')?.[1];
    if (!id) return [];
    return [
      {
        id: `${n}-${id}`,
        title: text(title) || '(bez tematu)',
        who: text(who),
        date: unix(text(date)),
        sent: name === 'out',
        // The site prints unread rows in bold.
        unread: name === 'in' && /bold/.test(who.getAttribute('style') ?? ''),
      },
    ];
  });
}

/** One message by its list id ("5-123"). Opening it marks it read, on the site as in the API. */
export async function message(login, key) {
  const [n, id] = key.split('-');
  const doc = await page(login, `wiadomosci/1/${n}/${id}/f0`);
  const label = (name) => [...doc.querySelectorAll('td > b')].find((b) => text(b) === name);
  const field = (name) => text(label(name)?.parentElement.nextElementSibling);
  if (!label('Temat')) throw new Error('http_404');
  // A sent message has no sender row; its recipients are the rows of the "Przeczytano" table.
  const readers = n === String(FOLDER.out) ? [...(label('Przeczytano')?.closest('table').rows ?? [])].slice(1) : [];
  return {
    title: field('Temat') || '(bez tematu)',
    from: field('Nadawca'),
    to: readers.map((tr) => text(tr.cells[0])).filter(Boolean).join(', '),
    date: unix(field('Wysłano')),
    body: plain(doc.querySelector('.container-message-content')?.innerHTML ?? ''),
    files: [...doc.querySelectorAll('img[onclick*="pobierz_zalacznik"]')].map((img) => ({
      Id: /pobierz_zalacznik\\?\/\d+\\?\/(\d+)/.exec(img.getAttribute('onclick'))?.[1],
      Name: text(img.closest('tr')?.cells[0]),
    })),
  };
}

/** Where the site hands out an attachment, in the shape of the API's answer: { DownloadUrl }. */
export const fileLink = (login, key, file) =>
  api(`w/${encodeURIComponent(login)}/wiadomosci/pobierz_zalacznik/${key.split('-')[1]}/${file.Id}`);

/** The unread badge: from the API, or for an account it refuses from the website, read at most every 5 minutes. */
export async function refreshUnread(login) {
  if (!students.has(login)) {
    if ((await countByApi(login)) !== 'premium') return;
    students.add(login);
  }
  if (Date.now() - (counted.get(login) ?? 0) < EVERY) return;
  counted.set(login, Date.now());
  page(login, `wiadomosci/${FOLDER.in}`).catch(() => counted.delete(login));
}
