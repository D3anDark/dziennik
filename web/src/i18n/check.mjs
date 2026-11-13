// Every text the interface passes to t() or plural() has to be in each dictionary, with the same {placeholders},
// and nothing else may be there. `node src/i18n/check.mjs` fails with the list; `--missing` prints the gaps as JSON.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from './en.js';
import uk from './uk.js';

const src = new URL('..', import.meta.url).pathname;
const DICTS = { en: [en, 2], uk: [uk, 3] };
const literal = (q) => new Function(`return ${q}`)();
const STRING = String.raw`('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\x60(?:\\.|[^\x60\\$])*\x60)`;
const T = new RegExp(String.raw`\bt\(\s*${STRING}`, 'g');
const DYNAMIC = /\bt\((?!\s*['"`])/g;
const PLURAL = new RegExp(String.raw`\bplural\([^,()]+,\s*\[\s*${STRING}\s*,\s*${STRING}\s*,\s*${STRING}\s*\]`, 'g');
const PLURAL_ANY = /\bplural\(/g;

const texts = new Set();
const forms = new Set();
const problems = [];
for (const file of readdirSync(src, { recursive: true })) {
  if (!/\.(svelte|js)$/.test(file) || file.startsWith('i18n') || file === 'demo.js') continue;
  const code = readFileSync(join(src, file), 'utf8');
  for (const m of code.matchAll(T)) texts.add(literal(m[1]));
  for (const m of code.matchAll(PLURAL)) forms.add([m[1], m[2], m[3]].map(literal).join('|'));
  const counted = (re) => [...code.matchAll(re)].length;
  if (counted(DYNAMIC)) problems.push(`${file}: t() with a text that is not a literal`);
  if (counted(PLURAL_ANY) > counted(PLURAL)) problems.push(`${file}: plural() without three literal forms`);
}

const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
const missing = {};
for (const [name, [dict, count]] of Object.entries(DICTS)) {
  missing[name] = [...texts, ...forms].filter((k) => !Object.hasOwn(dict, k));
  for (const k of missing[name]) problems.push(`${name}: missing ${JSON.stringify(k)}`);
  for (const [k, v] of Object.entries(dict)) {
    if (!texts.has(k) && !forms.has(k)) problems.push(`${name}: unused ${JSON.stringify(k)}`);
    else if (forms.has(k) ? !(Array.isArray(v) && v.length === count && v.every((x) => typeof x === 'string' && x)) : typeof v !== 'string' || !v)
      problems.push(`${name}: wrong value for ${JSON.stringify(k)}`);
    else if (texts.has(k) && holes(k) !== holes(v)) problems.push(`${name}: placeholders differ in ${JSON.stringify(k)}`);
  }
}

if (process.argv.includes('--missing')) console.log(JSON.stringify(missing, null, 1));
else if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
} else console.log(`i18n: ${texts.size} texts and ${forms.size} plurals in en and uk`);
