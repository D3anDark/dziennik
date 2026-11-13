import { locale, t } from './i18n.js';

export { plural } from './i18n.js';

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

export const fmtDay = (s) => parse(s).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
/** The school year a date belongs to, September to August, by the year it starts in. */
const schoolYear = (d) => d.getFullYear() - (d.getMonth() < 8);
/** "14 paź"; the year only for a date outside the current school year. */
export function fmtDate(s) {
  if (!s) return '';
  const d = parse(s);
  const year = schoolYear(d) !== schoolYear(new Date()) ? { year: 'numeric' } : {};
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...year });
}
/** How long ago, in the words a list of news uses: "9 min", "3 godz.", "wczoraj", then the date; `past` adds "temu". */
export function ago(unix, past = false) {
  const then = new Date(Number(unix) * 1000);
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return t('teraz');
  if (minutes < 60) return past ? t('{n} min temu', { n: minutes }) : t('{n} min', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (iso(then) === today()) return past ? t('{n} godz. temu', { n: hours }) : t('{n} godz.', { n: hours });
  if (iso(then) === shift(today(), -1)) return t('wczoraj');
  return then.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(then.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
}

const percent = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hundredths = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "60,0%": Polish writes a decimal comma, the locale decides. */
export const fmtPercent = (ratio) => percent.format(ratio);
/** "4,67" */
export const fmtAverage = (v) => hundredths.format(v);

/**
 * A 1 to 6 grade as a number for an average: a plus counted half a grade up and a minus a quarter down, unless
 * `plus` and `minus` say otherwise (PLUS and MINUS below: schools differ). Null for any other mark ("+", "np", "0",
 * "5%").
 */
export const worth = (v, plus = 0.5, minus = 0.25) => {
  const n = parseInt(v, 10);
  return n >= 1 && n <= 6 && !String(v).includes('%') ? n + (String(v).endsWith('+') ? plus : String(v).endsWith('-') ? -minus : 0) : null;
};

export const fmtUnix = (unix) =>
  new Date(Number(unix) * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

/** Two letters for an avatar: first and last word of a name. */
export function initials(name) {
  const w = String(name ?? '').split(/[\s,]+/).filter((x) => /^\p{L}/u.test(x));
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}

/** Grade colour class: g1..g6 by the leading digit, g0 for marks like "+", "np", "bz". */
export const gradeTone = (v) => {
  const n = parseInt(String(v), 10);
  return n >= 1 && n <= 6 && !String(v).includes('%') ? `g${n}` : 'g0';
};

/** A switch of "Ustawienia", kept on this device: on is "1" under its key. Without storage it reads as off. */
export const stored = (key) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

/**
 * Forced averages: the app counts them from every 1 to 6 grade, whatever Librus sends. For a school that asks for an
 * average and keeps its grades where Librus counts none (descriptive ones, categories left out of the average).
 * shortcut: one switch for every student on this device; key it by login once a parent has children at schools that
 * count differently.
 */
export const FORCED_KEY = 'forced-averages';

/**
 * A choice of "Ustawienia", kept on this device: one of the setting's `options`, the first (the default, which keeps
 * nothing) when nothing or anything else is kept.
 */
export const choiceOf = ({ key, options }) => {
  try {
    const kept = localStorage.getItem(key);
    return options.includes(kept) ? kept : options[0];
  } catch {
    return options[0];
  }
};

/** What a plus adds to a grade and a minus takes off it in an average the app counts (`worth`): schools differ. */
export const PLUS = { key: 'plus-worth', options: ['0.5', '0.33', '0.25', '0'] };
export const MINUS = { key: 'minus-worth', options: ['0.25', '0.33', '0.5', '0'] };

/** The year's average the app counts: from every grade of the year, or as the mean of the two semesters' averages. */
export const YEAR = { key: 'year-average', options: ['all', 'halves'] };

/** The tints a mark can take (app.css), with their names: the grade scale's and the one blue. */
export const TONES = [['g1', t('czerwony')], ['g2', t('pomarańczowy')], ['g3', t('żółty')], ['g4', t('limonkowy')], ['g5', t('zielony')], ['blue', t('niebieski')], ['g0', t('szary')]];

/**
 * The standard kinds of attendance entry that are not plain presence, by Synergia's id and in the order they are
 * listed: what each is called, in full and short, the symbol schools usually give it, and the tint of its mark,
 * picked in "Ustawienia" with the default first. A kind a school made up stays grey.
 */
export const ATTENDANCE = new Map(
  [
    [1, t('Nieusprawiedliwione'), t('Nieuspr.'), 'nb', 'g1'],
    [3, t('Usprawiedliwione'), t('Uspr.'), 'u', 'g5'],
    [2, t('Spóźnienia'), t('Spóźn.'), 'sp', 'blue'],
    [4, t('Zwolnienia'), t('Zwoln.'), 'zw', 'g3'],
  ].map(([std, label, word, sample, tone]) => [std, { label, word, sample, key: `attendance-tone/${std}`, options: [tone, ...TONES.map(([t]) => t).filter((t) => t !== tone)] }]),
);

/** Set once the first-run tour was seen or skipped (Tour.svelte); "Ustawienia" drops it to show the tour again. */
export const TOUR_KEY = 'tour-seen';

/** The plan's view: by the width of the screen until one is picked, in the plan itself or in "Ustawienia". */
export const PLAN = { key: 'plan-view', options: ['', 'day', 'week'] };

/** The theme: the system's unless one is picked in "Ustawienia". */
export const THEME = { key: 'theme', options: ['', 'light', 'dark'] };

// What on the page depends on the system's theme, each with the condition it came with and a way to change it.
let themed;

/**
 * Puts the theme on the page. The dark tokens are written once, in the `prefers-color-scheme: dark` block of app.css:
 * a picked theme rewrites that block's condition to always or never, rather than keeping a second copy of the tokens.
 * The browser bar's colours (index.html) and `color-scheme` (form controls, scrollbars) follow.
 * shortcut: applied when this script runs, so a theme picked against the system's can flash for a frame while the
 * page loads; upgrade to a blocking script in index.html if that shows.
 */
export function applyTheme(theme = choiceOf(THEME)) {
  // Nothing picked and nothing to undo: the stylesheet is left as it came.
  if (!theme && !themed) return;
  themed ??= [
    ...[...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules];
        } catch {
          // Another origin's stylesheet cannot be read, and holds none of the app's colours.
          return [];
        }
      })
      .filter((rule) => rule.media)
      .map((rule) => [rule.media.mediaText, (when) => (rule.media.mediaText = when)]),
    ...[...document.querySelectorAll('meta[name=theme-color][media]')].map((meta) => [meta.getAttribute('media'), (when) => meta.setAttribute('media', when)]),
  ].filter(([was]) => was.includes('prefers-color-scheme'));
  for (const [was, set] of themed) set(theme ? (was.includes(theme) ? 'all' : 'not all') : was);
  document.documentElement.style.colorScheme = theme;
}

/**
 * Screenshot mode, switched in "Ustawienia": a person is a first name and the initial of the surname
 * ("Anna N."), an e-mail its first letter and its domain. Read once: the switch loads the page again, so no view
 * keeps a full name it made before.
 */
export const SHORT_KEY = 'short-names';
export const short = stored(SHORT_KEY);

/**
 * A name from its two parts; Librus stores a missing part as the string "null". One part alone stays whole in
 * screenshot mode: it names an office ("Sekretariat"), not a person.
 */
export function named(first, last) {
  const [f, l] = [first, last].map((x) => (x && x !== 'null' ? String(x).trim() : ''));
  return [f, short && f && l ? `${[...l][0]}.` : l].filter(Boolean).join(' ');
}

export const person = (u) => named(u?.FirstName, u?.LastName) || t('Nieznany');

/** A name written first name first, as an account's student is: "Zuzanna Kowalczyk" is "Zuzanna K." in screenshot mode. */
export const alias = (name) => (short ? String(name).replace(/\s+(\S)\S*$/u, ' $1.') : name);

/**
 * Names as the Synergia website writes them, surname first and comma-separated: "Nowak Anna (nauczyciel)" is
 * "Anna N. (nauczyciel)" in screenshot mode. One word alone stays.
 * shortcut: a surname of two words keeps its second; upgrade if the site turns out to write such names.
 */
export const surnameFirst = (names) =>
  short
    ? String(names)
        .split(/,\s*/)
        .map((n) => n.replace(/^(\S)\S*\s+([^(]*?\S)(?=\s*(?:\(|$))/u, '$2 $1.'))
        .join(', ')
    : names;

/** An e-mail address: "k…@gmail.com" in screenshot mode. */
export const mail = (address) => (short ? String(address).replace(/^(.)[^@]*/u, '$1…') : address);

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
export const room = (name) => (/^sala\b/i.test(name) ? name : t('sala\u00a0{name}', { name }));

export const linkParts = (text) => text.split(/(https?:\/\/[^\s<>"]+)/);
