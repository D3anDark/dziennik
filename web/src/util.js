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
export const fmtDate = (s) =>
  s ? parse(s).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
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
export const linkParts = (text) => text.split(/(https?:\/\/[^\s<>"]+)/);
