import { api, post, inbox, refreshUnread as countByApi } from './api.svelte.js';
import { plain, surnameFirst } from './util.js';
import { t } from './i18n.js';

/**
 * Messages read from the Synergia website, for accounts the API refuses (no Mobilne Dodatki). The server passes
 * each page on as a string and it is parsed here in an inert document: nothing in it runs or loads.
 * Writing fills in the site's own form (#formWiadomosci) and submits it through the server.
 * Selectors follow the site's markup as of November 2026.
 */
const FOLDER = { in: 5, out: 6 };
/** Limits the site's form checks before it submits: wyslij_wiadomosc(button, 150, 20000, ...). */
const MAX_SUBJECT = 150;
const MAX_BODY = 20000;
// Every person of each recipient group read so far; the site's form submits the whole list next to the ticked ones.
const listed = new Map();
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
        title: text(title) || t('(bez tematu)'),
        who: surnameFirst(text(who)),
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
    title: field('Temat') || t('(bez tematu)'),
    from: surnameFirst(field('Nadawca')),
    to: readers.map((tr) => surnameFirst(text(tr.cells[0]))).filter(Boolean).join(', '),
    date: unix(field('Wysłano')),
    body: plain(doc.querySelector('.container-message-content')?.innerHTML ?? ''),
    files: [...doc.querySelectorAll('img[onclick*="pobierz_zalacznik"]')].map((img) => ({
      Id: /pobierz_zalacznik\\?\/\d+\\?\/(\d+)/.exec(img.getAttribute('onclick'))?.[1],
      Name: text(img.closest('tr')?.cells[0]),
    })),
  };
}

const submit = (login, path, fields) => post(`w/${encodeURIComponent(login)}/${path}`, fields);

/** What a form of the module submits as it stands: its hidden fields, the site's request key among them. */
function hidden(doc) {
  const form = doc.querySelector('#formWiadomosci');
  if (!form) throw new Error('upstream');
  return [...form.elements].filter((el) => el.type === 'hidden' && el.name).map((el) => [el.name, el.value]);
}

/**
 * Recipient groups in the shape Compose lists them: the groups the new-message form offers this account. Left out:
 * parents and guardians as in the API version, "grupa" (it asks for a second choice this form does not have) and
 * "sadmin" (Librus support, not the school). An id is "group/person": the site sends to one group at a time.
 */
export async function groups(login) {
  const doc = await page(login, `wiadomosci/2/${FOLDER.in}`);
  const kinds = [...doc.querySelectorAll('input[name="adresat"]')].flatMap((radio) => {
    // onClick='selectRecipients("nauczyciel", false, 0 );'
    const call = /selectRecipients\(\s*"(\w+)"\s*,\s*(\w+)\s*,\s*(\d+)/.exec(radio.getAttribute('onclick') ?? '');
    if (!call || /rodzic|opiekun|^grupa$|^sadmin$/.test(call[1])) return [];
    return [{ kind: call[1], virtual: call[2], group: call[3], label: text(doc.querySelector(`label[for="${radio.id}"]`)) || call[1] }];
  });
  const sections = await Promise.all(
    kinds.map(async ({ kind, virtual, group, label }) => {
      const fields = [['typAdresata', kind], ['poprzednia', String(FOLDER.in)], ['tabZaznaczonych', ''], ['czyWirtualneKlasy', virtual], ['idGrupy', group]];
      const html = await submit(login, 'getRecipients', fields).then((r) => r.html, () => '');
      const boxes = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('input[name="DoKogo[]"]')];
      listed.set(kind, boxes.map((box) => box.value));
      return { label, people: boxes.map((box) => ({ Id: `${kind}/${box.value}`, Label: surnameFirst(text(box.closest('tr')?.querySelector('label'))) })) };
    }),
  );
  return sections.filter((s) => s.people.length);
}

/**
 * Sends a new message to `receivers` (ids from `groups`) or answers the received message `originalMessageId`, and
 * returns the list id of the sent message. The site's answer to the form is not read: a message counts as sent when
 * it turns up in the sent folder, which also holds when the answer got lost on the way.
 */
export async function send(login, { subject, body, receivers, originalMessageId }) {
  if (subject.length > MAX_SUBJECT) throw new Error('subject_long');
  if (body.length > MAX_BODY) throw new Error('body_long');
  const kinds = new Set((receivers ?? []).map((r) => r.split('/')[0]));
  if (kinds.size > 1) throw new Error('one_group');
  const before = new Set((await folder(login, 'out')).map((m) => m.id));
  // The form is read right before it is submitted: its request key belongs to the session open at that moment.
  let path = `wiadomosci/${FOLDER.in}`;
  let fields;
  if (originalMessageId) {
    path = 'wiadomosci';
    fields = hidden(await page(login, `wiadomosci/3/${FOLDER.in}/${originalMessageId.split('-')[1]}`));
  } else {
    const [kind] = kinds;
    fields = [
      ...hidden(await page(login, `wiadomosci/2/${FOLDER.in}`)),
      ['adresat', kind],
      ...receivers.map((r) => ['DoKogo[]', r.split('/')[1]]),
      ...(listed.get(kind) ?? []).map((id) => ['DoKogo_hid[]', id]),
    ];
  }
  fields.push(['temat', subject], ['tresc', body], ['wyslij', 'Wyślij']);
  const failed = await submit(login, path, fields).then(() => null, (e) => e);
  const made = (await folder(login, 'out')).find((m) => !before.has(m.id));
  if (!made) throw failed ?? new Error('unconfirmed');
  return made.id;
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
