const pad = (n) => String(n).padStart(2, '0');

/** Local-date strings (YYYY-MM-DD) everywhere: Librus dates carry no zone and mean school-local days. */
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const shift = (s, days) => {
  const d = parse(s);
  d.setDate(d.getDate() + days);
  return iso(d);
};
export const today = () => iso(new Date());
export const mondayOf = (s) => shift(s, -((parse(s).getDay() + 6) % 7));

export const fmtDay = (s) => parse(s).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
/** The school year a date belongs to, September to August, by the year it starts in. */
const schoolYear = (d) => d.getFullYear() - (d.getMonth() < 8);
/** "14 paź"; the year only for a date outside the current school year. */
export function fmtDate(s) {
  if (!s) return '';
  const d = parse(s);
  const year = schoolYear(d) !== schoolYear(new Date()) ? { year: 'numeric' } : {};
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', ...year });
}
/** How long ago, in the words a list of news uses: "9 min", "3 godz.", "wczoraj", then the date. */
export function ago(t) {
  const then = new Date(Number(t) * 1000);
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return 'teraz';
  if (minutes < 60) return `${minutes} min`;
  if (iso(then) === today()) return `${Math.floor(minutes / 60)} godz.`;
  if (iso(then) === shift(today(), -1)) return 'wczoraj';
  return then.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', ...(then.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
}

const percent = new Intl.NumberFormat('pl-PL', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hundredths = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "60,0%": Polish writes a decimal comma. */
export const fmtPercent = (ratio) => percent.format(ratio);
/** "4,67" */
export const fmtAverage = (v) => hundredths.format(v);

const plurals = new Intl.PluralRules('pl-PL');
/** The word that goes with `n`: forms for 1, for 2–4 (22–24…) and for 5 and on, e.g. wiadomość, wiadomości, wiadomości. */
export const plural = (n, [one, few, many]) => ({ one, few })[plurals.select(n)] ?? many;

export const fmtUnix = (t) =>
  new Date(Number(t) * 1000).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });

/** Two letters for an avatar: first and last word of a name. */
export function initials(name) {
  const w = String(name ?? '').split(/[\s,]+/).filter((x) => /^\p{L}/u.test(x));
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}

/** Grade colour class: g1..g6 by the leading digit, g0 for marks like "+", "np", "bz". */
export const gradeTone = (v) => {
  const n = parseInt(String(v), 10);
  return n >= 1 && n <= 6 ? `g${n}` : 'g0';
};

/** Librus stores missing name parts as the string "null". */
export function person(u) {
  const name = [u?.FirstName, u?.LastName].filter((x) => x && x !== 'null').join(' ');
  return name || 'Nieznany';
}

/**
 * Teacher-written HTML becomes plain text: rendering it as markup would run whatever a school account typed.
 * Some fields arrive JSON-encoded (a quoted string), so that layer is peeled first.
 */
export function plain(s) {
  if (typeof s !== 'string') return '';
  try {
    const j = JSON.parse(s);
    if (typeof j === 'string') s = j;
  } catch {
    // already a bare string
  }
  const html = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n');
  // DOMParser documents are inert: no scripts run and no images load while decoding entities.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('script, style')) el.remove();
  const text = doc.body.textContent ?? '';
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** Splits text so http(s) URLs can be rendered as links; odd indices are URLs. */
/** "sala 104", kept on one line, and a room the school already named "sala gim." as it is. */
export const room = (name) => (/^sala\b/i.test(name) ? name : `sala\u00a0${name}`);

export const linkParts = (text) => text.split(/(https?:\/\/[^\s<>"]+)/);
