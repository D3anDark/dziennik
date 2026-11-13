import en from './i18n/en.js';
import uk from './i18n/uk.js';

/** Languages of the interface. Data from Librus (subjects, categories, messages) stays as the school wrote it. */
export const LANGS = { pl: 'Polski', en: 'English', uk: 'Українська' };
const KEY = 'lang';

function chosen() {
  try {
    const l = localStorage.getItem(KEY);
    return Object.hasOwn(LANGS, l) ? l : 'pl';
  } catch {
    return 'pl';
  }
}

/** Fixed for the page's lifetime: `setLang` reloads, so module-level labels can be translated once at import. */
export const lang = chosen();
export const locale = { pl: 'pl-PL', en: 'en-GB', uk: 'uk-UA' }[lang];
const dict = { en, uk }[lang];
document.documentElement.lang = lang;

/** The Polish text is the key; `{name}` takes a value from `vars`. A missing translation falls back to Polish. */
export function t(text, vars) {
  const s = dict?.[text] ?? text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}

const rules = new Intl.PluralRules(locale);
/** Forms per category, in this order: Polish and Ukrainian have three for whole numbers, English two. */
const ORDER = lang === 'en' ? ['one', 'other'] : ['one', 'few', 'many'];
/**
 * The word that goes with `n`, from the Polish forms for 1, for 2-4 (22-24...) and for 5 and on, e.g. wiadomość,
 * wiadomości, wiadomości. The dictionary keeps the translated forms under the Polish ones joined with "|".
 */
export function plural(n, forms) {
  const own = dict?.[forms.join('|')] ?? forms;
  const i = ORDER.indexOf(rules.select(n));
  return own[i < 0 ? own.length - 1 : i];
}

export function setLang(l) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    return;
  }
  location.reload();
}
