/**
 * The demo build (`npm run demo`, vite --mode demo) answers the app's /api calls inside the page with made-up data,
 * so the app can be tried on a static host (GitHub Pages) without a server or a Librus account. Dates follow the
 * device clock and one day always gives the same data; what the visitor changes (read, done, sent) lasts until reload.
 */
import { today, shift, parse, worth } from './util.js';

const T = today();
const NOW = Math.floor(Date.now() / 1000);

/** Seeded generator (mulberry32 over an FNV hash), so a reload shows the same grades. */
function random(seed) {
  let a = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const weekday = (s) => parse(s).getDay();
const summer = (s) => [7, 8].includes(parse(s).getMonth() + 1);
// shortcut: school days are weekdays (past ones skip July and August), no other breaks; a visit in summer sees lessons.
function schoolDays(from, n, step) {
  const out = [];
  for (let d = shift(from, step); out.length < n; d = shift(d, step)) if (weekday(d) % 6 && (step > 0 || !summer(d))) out.push(d);
  return step < 0 ? out.reverse() : out;
}
const ahead = (n) => schoolDays(T, n, 1)[n - 1];
const back = (n) => schoolDays(T, n, -1)[0];
const unix = (date, time) => Math.floor(new Date(`${date}T${time}:00`).getTime() / 1000);
const semester = (date) => (parse(date).getMonth() + 1 >= 9 || parse(date).getMonth() === 0 ? 1 : 2);
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

const SUBJECTS = ['Język polski', 'Matematyka', 'Język angielski', 'Język niemiecki', 'Historia', 'Biologia', 'Chemia', 'Fizyka', 'Geografia', 'Informatyka', 'Muzyka', 'Plastyka', 'Wychowanie fizyczne', 'Zajęcia z wychowawcą', 'Przyroda', 'Technika'].map(
  (Name, i) => ({ Id: i + 1, Name }),
);
const ROOMS = { 1: '12', 2: '21', 3: '33', 4: '34', 5: '14', 6: '25', 7: '27', 8: '26', 9: '15', 10: '31', 11: '8', 12: '8', 13: 'sala gim.', 14: '12', 15: '25', 16: '9' };
const USERS = [
  [1, 'Katarzyna', 'Wiśniewska'], [2, 'Tomasz', 'Lewandowski'], [3, 'Joanna', 'Zielińska'], [4, 'Beata', 'Grabowska'],
  [5, 'Marek', 'Wójcik'], [6, 'Agnieszka', 'Kamińska'], [7, 'Magdalena', 'Dąbrowska'], [8, 'Paweł', 'Szymański'],
  [9, 'Ewa', 'Mazur'], [10, 'Michał', 'Krawczyk'], [11, 'Anna', 'Piotrowska'], [12, 'Piotr', 'Kaczmarek'],
  [13, 'Renata', 'Wróbel'], [14, 'Jacek', 'Nowicki'], [20, 'Sekretariat', 'null'],
  [100, 'Anna', 'Kowalczyk'], [101, 'Zuzanna', 'Kowalczyk'], [102, 'Antoni', 'Kowalczyk'], [103, 'Maja', 'Kowalczyk'],
].map(([Id, FirstName, LastName]) => ({ Id, FirstName, LastName }));
const HOURS = [['08:00', '08:45'], ['08:55', '09:40'], ['09:50', '10:35'], ['10:50', '11:35'], ['11:55', '12:40'], ['12:50', '13:35'], ['13:45', '14:30']];
const PARENT = 100;

/**
 * The three children of one parent. `teachers` maps subject to teacher, `week` lists subjects by lesson, Monday first.
 * The third goes to another school, for what the first two never meet: subjects graded in points, in percent, in
 * letters with a phrase and in words (`systems`), 1 to 6 grades kept as descriptive ones, averages Librus does not
 * send (`hidden`), a kind of attendance of the school's own and behaviour points that start from some (`start`).
 */
const STUDENTS = {
  demo1: {
    name: 'Zuzanna Kowalczyk', user: 101, base: 1000, cls: [7, 'b'], tutor: 1, skill: 4.6,
    teachers: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 12: 11, 13: 12, 14: 1 },
    week: [[1, 2, 3, 5, 6, 13, 14], [2, 8, 1, 4, 9, 13, 11], [7, 3, 2, 1, 10, 5], [6, 1, 2, 8, 3, 13, 12], [9, 7, 4, 1, 2, 3]],
  },
  demo2: {
    name: 'Antoni Kowalczyk', user: 102, base: 2000, cls: [4, 'a'], tutor: 13, skill: 4.1,
    teachers: { 1: 13, 2: 2, 3: 3, 5: 5, 10: 10, 11: 11, 12: 11, 13: 12, 14: 13, 15: 6, 16: 14 },
    week: [[1, 2, 15, 3, 13], [2, 1, 5, 16, 13, 14], [3, 1, 2, 12, 10], [15, 2, 1, 11, 13], [1, 3, 2, 15, 13]],
  },
  demo3: {
    name: 'Maja Kowalczyk', user: 103, base: 3000, cls: [6, 'c'], tutor: 9, skill: 4.3,
    teachers: { 1: 9, 2: 8, 3: 3, 5: 5, 10: 10, 11: 11, 12: 11, 13: 12, 14: 9, 15: 6, 16: 14 },
    week: [[2, 1, 3, 15, 13], [1, 2, 5, 10, 11, 14], [3, 2, 1, 12, 13], [15, 1, 2, 16, 5], [2, 3, 1, 10, 13]],
    systems: { 2: 'points', 3: 'points', 15: 'percent', 10: 'described', 11: 'letters', 12: 'letters', 16: 'letters', 13: 'words' },
    hidden: true,
    start: 100,
    school: 'Szkoła Podstawowa nr 12 im. Marii Skłodowskiej-Curie',
  },
};

/** What the third child's school grades with, beside the 1 to 6 scale. */
const POINT_CATEGORIES = [
  { Id: 1, Name: 'Sprawdzian', ValueFrom: 0, ValueTo: 30, Weight: 3 },
  { Id: 2, Name: 'Kartkówka', ValueFrom: 0, ValueTo: 10, Weight: 2 },
  { Id: 3, Name: 'Praca domowa', ValueFrom: 0, ValueTo: 5, Weight: 1 },
];
const SKILLS = ['Zaangażowanie', 'Wykonanie pracy', 'Samodzielność', 'Praca na lekcji'].map((Name, i) => ({ Id: i + 1, Name }));
const LETTERS = { A: 'Opanowane w pełni.', B: 'Opanowane, z drobnymi brakami.', C: 'Wymaga jeszcze ćwiczeń.' };
const WHOLE = [{ Id: 1, Name: 'Diagnoza na początku roku' }, { Id: 2, Name: 'Ocena śródroczna' }];

const CATEGORIES = [
  { Id: 1, Name: 'Sprawdzian', Weight: 3, CountToTheAverage: true },
  { Id: 2, Name: 'Kartkówka', Weight: 2, CountToTheAverage: true },
  { Id: 3, Name: 'Odpowiedź ustna', Weight: 2, CountToTheAverage: true },
  { Id: 4, Name: 'Praca domowa', Weight: 1, CountToTheAverage: true },
  { Id: 5, Name: 'Praca na lekcji', Weight: 1, CountToTheAverage: true },
  { Id: 6, Name: 'Aktywność', Weight: 1, CountToTheAverage: false },
  { Id: 7, Name: 'Projekt', Weight: 2, CountToTheAverage: true },
  { Id: 8, Name: 'Ocena semestralna', IsSemestral: true },
  { Id: 9, Name: 'Proponowana ocena semestralna', IsSemestralProposition: true },
  { Id: 10, Name: 'Proponowana ocena roczna', IsFinalProposition: true },
  { Id: 11, Name: 'Ocena roczna', IsFinal: true },
];
/** What each kind of subject is graded for. */
const GRADED_BY = { arts: [5, 7, 6, 5], pe: [5, 5, 6], it: [5, 7, 2, 5], other: [1, 2, 2, 3, 4, 5, 6, 1, 2] };
const kindOf = (subject) => ({ 11: 'arts', 12: 'arts', 16: 'arts', 13: 'pe', 10: 'it' })[subject] ?? 'other';
const COMMENTS = ['Bardzo dobrze rozwiązane zadania otwarte.', 'Do poprawy w ciągu dwóch tygodni.', 'Zabrakło uzasadnienia w zadaniu 3.', 'Praca staranna i przemyślana.'];

const TOPICS = {
  1: ['Charakterystyka postaci literackiej', '„Opowieść wigilijna”: przemiana bohatera', 'Wypowiedzenia złożone współrzędnie', 'Ćwiczenia w pisaniu rozprawki', 'Środki stylistyczne w poezji', 'Fraszki Jana Kochanowskiego'],
  2: ['Równania pierwszego stopnia', 'Zadania tekstowe z równaniami', 'Potęgi o wykładniku naturalnym', 'Pierwiastki kwadratowe', 'Twierdzenie Pitagorasa', 'Pole trapezu: zadania'],
  3: ['Unit 4: Food and drinks', 'Present Perfect: affirmative sentences', 'Listening practice', 'Writing an email to a friend', 'Vocabulary revision'],
  4: ['Mein Tagesablauf', 'Czasowniki rozdzielnie złożone', 'Uhrzeit: podawanie godzin', 'Powtórzenie wiadomości'],
  5: ['Reformy Sejmu Czteroletniego', 'Konstytucja 3 maja', 'Insurekcja kościuszkowska', 'Trzeci rozbiór Polski'],
  6: ['Budowa i praca serca', 'Krwiobieg duży i mały', 'Skład krwi', 'Odporność organizmu'],
  7: ['Wiązania chemiczne', 'Reakcje syntezy i analizy', 'Prawo zachowania masy', 'Tlenki: otrzymywanie'],
  8: ['Ruch jednostajny prostoliniowy', 'Prędkość średnia', 'Siła wypadkowa', 'Doświadczenie: pomiar prędkości'],
  9: ['Rzeźba terenu Polski', 'Klimat Polski', 'Wody powierzchniowe', 'Praca z mapą'],
  10: ['Algorytmy z warunkiem', 'Arkusz kalkulacyjny: formuły', 'Bezpieczeństwo w sieci', 'Programowanie w Scratchu'],
  11: ['Muzyka baroku', 'Śpiew: kolędy polskie', 'Instrumenty dęte'],
  12: ['Perspektywa linearna', 'Martwa natura: szkic', 'Kolor w malarstwie'],
  13: ['Gry zespołowe: siatkówka', 'Ćwiczenia ogólnorozwojowe', 'Lekkoatletyka: skok w dal', 'Koszykówka: kozłowanie'],
  14: ['Bezpieczne ferie', 'Sprawy klasowe', 'Jak się uczyć skutecznie'],
  15: ['Krajobraz najbliższej okolicy', 'Jak zbudowana jest roślina', 'Pogoda i jej składniki', 'Kierunki geograficzne'],
  16: ['Znaki drogowe ostrzegawcze', 'Budowa roweru', 'Bezpieczna droga do szkoły'],
};

const mark = (rnd, skill) => {
  const n = Math.min(6, Math.max(1, Math.round(skill + (rnd() + rnd() - 1) * 1.6)));
  const r = rnd();
  return String(n) + (r < 0.15 && n < 6 ? '+' : r > 0.88 && n > 1 ? '-' : '');
};
function average(list) {
  const counted = list.map((g) => [worth(g.Grade), CATEGORIES[g.Category.Id - 1]]).filter(([v, c]) => v && c.CountToTheAverage);
  const weight = counted.reduce((s, [, c]) => s + c.Weight, 0);
  return weight ? counted.reduce((s, [v, c]) => s + v * c.Weight, 0) / weight : 0;
}

/** Everything one student's account answers, made once per page load. */
function build(login) {
  const s = STUDENTS[login];
  const rnd = random(login + T);
  const on = (date) => s.week[weekday(date) - 1] ?? [];
  const lessonOf = (subject) => s.base + subject;
  const subjects = Object.keys(s.teachers).map(Number);
  // The school days of this school year so far (`all`; a year has about 190), the last 80 of them (`past`); in its
  // first weeks the end of the last one as well. Grades spread over `all`, so after January both semesters have some.
  const [month, day, year] = [parse(T).getMonth() + 1, parse(T).getDate(), parse(T).getFullYear()];
  const recentDays = schoolDays(T, 200, -1);
  const thisYear = recentDays.filter((d) => d >= `${month >= 9 ? year : year - 1}-09-01`);
  const all = thisYear.length >= 15 ? thisYear : recentDays.slice(-15);
  const past = all.slice(-80);
  const ago = (k) => past[Math.max(0, past.length - k)];
  const lessonNo = (date, subject) => on(date).indexOf(subject) + 1 || undefined;

  // Grades on the days the subject has lessons, two of them from the last school day so Start has news.
  const grades = [];
  const stamp = (subject, date) => ({
    Date: date, AddDate: `${date} ${12 + Math.floor(rnd() * 4)}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00`,
    Semester: semester(date), Subject: { Id: subject }, AddedBy: { Id: s.teachers[subject] },
  });
  const add = (subject, date, category, value) => grades.push({ Id: grades.length + 1, Grade: value, ...stamp(subject, date), Category: { Id: category } });
  // The grades of the other systems, by system (`systems` of the student): points out of a category's maximum near
  // the child's skill, a letter with its phrase, a 1 to 6 grade kept as a descriptive one, a word. A percent is a
  // grade of the 1 to 6 list, as a school with that scale keeps it.
  const other = { points: [], letters: [], described: [], words: [] };
  const part = (max) => Math.round(max * Math.min(1, Math.max(0.2, (s.skill - 1) / 5 + (rnd() - 0.5) * 0.4)));
  const elsewhere = {
    points: (subject, date) => {
      const category = pick(rnd, POINT_CATEGORIES);
      const got = part(category.ValueTo);
      return { ...stamp(subject, date), Category: { Id: category.Id }, Grade: String(got), GradeValue: got };
    },
    letters: (subject, date) => {
      const letter = pick(rnd, ['A', 'A', 'B', 'B', 'C']);
      return { ...stamp(subject, date), Skill: { Id: 1 + Math.floor(rnd() * 3) }, Map: letter, Phrase: LETTERS[letter] };
    },
    described: (subject, date) => ({ ...stamp(subject, date), Skill: { Id: 4 }, Map: mark(rnd, s.skill) }),
    words: (subject, date) => ({ ...stamp(subject, date), Grade: pick(rnd, ['zaliczono', 'zaliczono', 'zaliczono', 'brak stroju']) }),
  };
  const value = (subject, category) =>
    category === 6 ? (rnd() < 0.85 ? '+' : '-') : mark(rnd, kindOf(subject) === 'pe' || kindOf(subject) === 'arts' ? s.skill + 0.8 : s.skill);
  for (const subject of subjects.filter((x) => x !== 14)) {
    const perWeek = s.week.flat().filter((x) => x === subject).length;
    // 2 + 1.5 a weekly lesson in 16 weeks, by semester: one begun has at least one grade.
    for (const sem of [1, 2]) {
      const days = all.filter((d) => semester(d) === sem && on(d).includes(subject));
      const count = Math.min(days.length, Math.max(1, Math.round(((2 + perWeek * 1.5) * days.length) / (16 * perWeek))));
      for (const date of days.sort(() => rnd() - 0.5).slice(0, count)) {
        const system = s.systems?.[subject];
        const category = pick(rnd, GRADED_BY[kindOf(subject)]);
        if (system === 'percent') add(subject, date, category, `${part(100)}%`);
        else if (system) other[system].push(elsewhere[system](subject, date));
        else add(subject, date, category, value(subject, category));
      }
    }
  }
  const last = past.at(-1);
  for (const subject of on(last).filter((x) => x < 11 && !s.systems?.[x]).slice(0, 2)) add(subject, last, 2, value(subject, 2));
  // A test failed and written again: the improvement names the grade it improved, as Librus does.
  const retaken = subjects[0];
  add(retaken, ago(21), 1, '2');
  const failed = grades.at(-1);
  add(retaken, ago(14), 1, '4');
  const improvement = grades.at(-1);
  grades.sort((p, q) => p.Date.localeCompare(q.Date));
  grades.forEach((g, i) => (g.Id = i + 1));
  improvement.Improvement = { Id: failed.Id };
  for (const list of Object.values(other)) list.sort((p, q) => p.Date.localeCompare(q.Date)).forEach((g, i) => (g.Id = i + 1));
  // The pupil as a whole, in sentences: at the start of the year, and again once the first semester is over.
  const whole = s.systems
    ? [
        { GradeGroupId: 1, Grade: `${s.name.split(' ')[0]} dobrze czyta i liczy w pamięci, chętnie pracuje w grupie. Do ćwiczenia: staranność zapisu.`, AddDate: `${all[0]} 15:00:00` },
        ...(month >= 2 && month <= 8 ? [{ GradeGroupId: 2, Grade: `${s.name.split(' ')[0]} pracuje systematycznie i zabiera głos na lekcjach. Sprawdziany pisze coraz pewniej, zadania domowe oddaje w terminie.`, AddDate: `${year}-01-23 15:00:00` }] : []),
      ].map((g, i) => ({ ...g, Id: i + 1, AddedBy: { Id: s.tutor } }))
    : [];
  const comments = grades.filter((g) => g.Category.Id === 1 && rnd() < 0.5).map((g) => ((g.Comments = [{ Id: g.Id }]), { Id: g.Id, Text: pick(rnd, COMMENTS) }));

  // Final and proposed grades by the time of year.
  const ofSubject = (subject, sem) => grades.filter((g) => g.Subject.Id === subject && (!sem || g.Semester === sem) && g.Category.Id < 8);
  const round = (avg) => String(Math.min(6, Math.max(1, Math.round(avg || s.skill))));
  const finals = [];
  for (const subject of subjects.filter((x) => x !== 14)) {
    const at = (date, category, sem, avg) => finals.push({ Subject: { Id: subject }, Date: date, Category: { Id: category }, Semester: sem, Grade: round(avg) });
    if (month >= 2 && month <= 8) at(`${year}-01-23`, 8, 1, average(ofSubject(subject, 1)));
    if (month === 12 || month === 1) at(back(5), 9, 1, average(ofSubject(subject, 1)));
    if (month === 5 || (month === 6 && day < 20)) at(back(5), 10, 2, average(ofSubject(subject)));
    if (month >= 7 && month <= 8) at(`${year}-06-20`, 11, 2, average(ofSubject(subject)));
  }
  for (const f of finals) grades.push({ ...f, Id: grades.length + 1, AddDate: `${f.Date} 15:00:00`, AddedBy: { Id: s.teachers[f.Subject.Id] } });
  const averages = subjects.map((subject) => {
    const fixed = (x) => (x ? x.toFixed(2) : '0.00');
    return { Subject: { Id: subject }, Semester1: fixed(average(ofSubject(subject, 1))), Semester2: fixed(average(ofSubject(subject, 2))), FullYear: fixed(average(ofSubject(subject))) };
  });

  // Attendance for every lesson held: two days off sick, a few late arrivals, one skipped lesson per child.
  const odd = new Map();
  for (const date of [ago(9 + Math.floor(rnd() * 6)), past[Math.floor(rnd() * (past.length - 15))]]) for (let no = 1; no <= on(date).length; no++) odd.set(`${date}/${no}`, 3);
  for (const k of [3, 12, 25]) odd.set(`${ago(k)}/1`, 2);
  odd.set(`${ago(6)}/${on(ago(6)).length}`, 1);
  if (login === 'demo2') odd.set(`${ago(15)}/3`, 1);
  const pe = past.findLast((d) => on(d).includes(13));
  // The third child's school has a kind of its own, a release for a competition.
  odd.set(`${pe}/${lessonNo(pe, 13)}`, s.systems ? 51 : 4);
  const attendances = past.flatMap((date) =>
    on(date).map((subject, i) => ({
      Id: `${date}/${i + 1}`, Date: date, LessonNo: String(i + 1), Type: { Id: odd.get(`${date}/${i + 1}`) ?? 100 }, Lesson: { Id: lessonOf(subject) }, Semester: semester(date),
    })),
  );

  const t = s.teachers;
  const first = s.name.split(' ')[0];
  const messages = [
    { from: s.tutor, at: NOW - 5400, unread: true, files: ['zgoda-na-wycieczke.pdf'], subject: 'Wycieczka: zgody i wpłaty',
      body: `Szanowni Państwo,<br><br>przypominam, że podpisane zgody na wycieczkę należy oddać do piątku. Koszt wycieczki to 180 zł, wpłaty przyjmuje skarbnik klasy. Zgoda jest w załączniku.<br><br>Pozdrawiam serdecznie<br>${USERS.find((u) => u.Id === s.tutor).FirstName} ${USERS.find((u) => u.Id === s.tutor).LastName}` },
    { from: t[2], at: unix(back(1), '16:05'), unread: true, subject: 'Sprawdzian z działu 4',
      body: 'Dzień dobry,<br>sprawdzian z działu 4 odbędzie się w przyszłym tygodniu. Zakres: zadania powtórzeniowe ze stron 128–132. Osoby nieobecne piszą go na konsultacjach w czwartek o 14:35.<br><br>Tomasz Lewandowski' },
    { from: 20, at: unix(back(4), '09:12'), subject: 'Ubezpieczenie NNW', body: 'Przypominamy o opłaceniu ubezpieczenia NNW na bieżący rok szkolny. Szczegóły na tablicy ogłoszeń przy sekretariacie.' },
    { from: 3, at: unix(back(8), '18:30'), subject: 'Szkolny konkurs językowy', body: `Dzień dobry,<br>zachęcam do zgłoszenia dziecka do szkolnego konkursu z języka angielskiego. ${first} ma szansę na dobry wynik. Zgłoszenia przyjmuję do końca miesiąca.<br><br>Joanna Zielińska` },
    { from: s.tutor, at: unix(back(15), '20:01'), subject: 'Zebranie z rodzicami', body: 'Szanowni Państwo,<br>zapraszam na zebranie. Omówimy wyniki w nauce, frekwencję i plan wycieczki. Proszę o potwierdzenie obecności.' },
    { to: s.tutor, at: unix(back(5), '07:15'), subject: `Nieobecność: ${first}`, body: `Dzień dobry,<br>proszę o usprawiedliwienie nieobecności ${{ Zuzanna: 'Zuzanny', Antoni: 'Antoniego', Maja: 'Mai' }[first]} w ubiegłym tygodniu z powodu choroby.<br><br>Z poważaniem<br>Anna Kowalczyk` },
  ].map((m, i) => ({ ...m, Id: String(s.base + i + 1), read: !m.unread }));

  const homework = {
    demo1: [
      [1, 'Charakterystyka bohatera', 'Napisz charakterystykę Ebenezera Scrooge’a (co najmniej 200 słów). Skorzystaj z karty pracy.', back(3), ahead(2), { read: true, files: ['karta-pracy.pdf'] }],
      [2, 'Równania', 'Podręcznik str. 132, zadania 1–6. Zadanie 7 dla chętnych.', back(1), ahead(1), {}],
      [3, 'Workbook', 'Workbook p. 45, ex. 1–4. Learn the new words from Unit 4.', back(6), back(1), { read: true }],
      [6, 'Plakat: układ krążenia', 'Przygotujcie w parach plakat o budowie serca i krwiobiegu, format A3.', back(8), ahead(7), { read: true }],
      [5, 'Notatka', 'Notatka w zeszycie: reformy Sejmu Czteroletniego.', back(12), back(7), { read: true, done: true }],
    ],
    demo2: [
      [1, 'Opowiadanie', 'Napisz opowiadanie o przygodzie na wycieczce (pół strony).', back(2), ahead(3), {}],
      [2, 'Mnożenie pisemne', 'Ćwiczenia str. 40, zadania 2 i 3.', back(1), ahead(1), { read: true }],
      [15, 'Zielnik', 'Zbierz i zasusz pięć liści różnych drzew, podpisz każdy z nich.', back(9), ahead(9), { read: true, files: ['instrukcja-zielnik.pdf'] }],
      [16, 'Znaki drogowe', 'Powtórz znaki drogowe ze stron 18–21.', back(10), back(3), { read: true, done: true }],
    ],
    demo3: [
      [2, 'Ułamki zwykłe', 'Zbiór zadań str. 58, zadania 4–9. Za zadanie jest 5 punktów.', back(1), ahead(2), {}],
      [1, 'Lektura', 'Przeczytaj rozdziały 3 i 4 „W pustyni i w puszczy”, przygotuj plan wydarzeń.', back(4), ahead(4), { read: true }],
      [15, 'Obserwacja pogody', 'Przez tydzień zapisuj temperaturę o 8:00 i 15:00, wyniki w tabeli.', back(7), back(1), { read: true, done: true, files: ['tabela-pogody.pdf'] }],
    ],
  }[login].map(([subject, Topic, Text, Date, DueDate, x], i) => ({ Id: s.base + i + 1, Topic, Text, Date, DueDate, Lesson: { Id: lessonOf(subject) }, Teacher: { Id: t[subject] }, ...x }));

  const tests = {
    demo1: [[1, 2, 3, 'Równania i nierówności, dział 4.'], [2, 3, 5, 'Unit 4: słownictwo.'], [1, 5, 9, 'Rozbiory Polski.'], [2, 6, -3, 'Budowa serca.'], [3, 10, 14, 'Prezentacja: bezpieczeństwo w sieci.'], [1, 1, 16, 'Romantyzm: ballady.']],
    demo2: [[2, 2, 2, 'Tabliczka mnożenia do 100.'], [1, 15, 6, 'Krajobrazy Polski.'], [2, 3, 8, 'Colours and clothes.'], [1, 1, -4, 'Rzeczownik i czasownik.']],
    demo3: [[1, 2, 4, 'Ułamki zwykłe: 30 punktów do zdobycia.'], [2, 3, 2, 'Irregular verbs, 10 punktów.'], [1, 5, 10, 'Polska Piastów.'], [3, 15, -2, 'Projekt: karmnik dla ptaków.']],
  }[login].map(([category, subject, n, content], i) => {
    const date = n > 0 ? ahead(n) : back(-n);
    return { Id: s.base + i + 1, Date: date, Category: { Id: category }, Subject: { Id: subject }, Content: content, LessonNo: String(lessonNo(date, subject) ?? 1), CreatedBy: { Id: t[subject] } };
  });
  const calendar = {
    HomeWorks: tests,
    ClassFreeDays: [{ Id: s.base + 1, DateFrom: ahead(11), DateTo: ahead(12), Type: { Id: 1 }, Name: login === 'demo1' ? 'Toruń: planetarium i Stare Miasto' : login === 'demo2' ? 'Ojców: Park Narodowy' : 'Wieliczka: kopalnia soli' }],
    TeacherFreeDays: [{ Id: s.base + 1, DateFrom: ahead(2), DateTo: ahead(2), Teacher: { Id: login === 'demo1' ? 8 : 5 } }],
    SchoolFreeDays: [{ Id: 1, DateFrom: ahead(18), DateTo: ahead(18), Name: 'Dzień wolny od zajęć dydaktycznych' }],
    ParentTeacherConferences: [{ Id: s.base + 1, Date: ahead(8), Name: 'Zebranie z rodzicami', Time: '17:30:00', Room: ROOMS[14], Topic: 'Wyniki w nauce i frekwencja', Teacher: { Id: s.tutor } }],
  };

  const notes = {
    demo1: [[1, 1, 'II miejsce w szkolnym konkursie matematycznym. Gratulacje!', 2, 9], [1, 2, 'Pomoc koledze w nadrobieniu zaległości z matematyki.', 1, 25], [0, 3, 'Brak stroju na lekcji wychowania fizycznego.', 12, 17]],
    demo2: [[1, 4, 'Aktywny udział w przygotowaniu akademii.', 13, 6], [0, 5, 'Rozmowy podczas lekcji mimo upomnień.', 3, 20]],
    demo3: [[1, 1, 'Wyróżnienie w międzyszkolnym konkursie recytatorskim.', 9, 7], [1, 3, 'Zawsze przygotowana do lekcji, zeszyt prowadzony wzorowo.', 8, 18]],
  }[login].map(([Positive, category, Text, teacher, n], i) => ({ Id: s.base + i + 1, Positive, Category: { Id: category }, Text, Teacher: { Id: teacher }, Date: back(n) }));

  // Topics of the last two weeks, each subject going through its list.
  const seen = {};
  const realizations = schoolDays(T, 10, -1).flatMap((date) =>
    on(date).map((subject, i) => ({ Id: `${date}/${i + 1}`, Date: date, LessonNo: String(i + 1), Lesson: { Id: lessonOf(subject) }, Topic: TOPICS[subject][(seen[subject] = (seen[subject] ?? -1) + 1) % TOPICS[subject].length] })),
  );

  // The day Start shows (today until its last lesson ends) has a substitute; the school day after it loses its last lesson.
  const next = weekday(T) % 6 && new Date().toTimeString().slice(0, 5) < HOURS[on(T).length - 1][1] ? T : ahead(1);
  const cut = schoolDays(next, 1, 1)[0];
  const timetable = (start) => {
    const out = {};
    for (let i = 0; i < 7; i++) {
      const date = shift(start, i);
      out[date] = on(date).map((subject, j) => {
        const teacher = USERS.find((u) => u.Id === t[subject]);
        const lesson = {
          LessonNo: String(j + 1), HourFrom: HOURS[j][0], HourTo: HOURS[j][1], Subject: { Id: subject, Name: SUBJECTS[subject - 1].Name },
          Teacher: { Id: teacher.Id, FirstName: teacher.FirstName, LastName: teacher.LastName }, Classroom: { Id: 100 + subject }, Lesson: { Id: lessonOf(subject) },
          IsCanceled: date === cut && j === on(date).length - 1, IsSubstitutionClass: false,
        };
        if (date === next && j === 2) {
          const sub = USERS.find((u) => u.Id === 9);
          Object.assign(lesson, { IsSubstitutionClass: true, Teacher: { Id: sub.Id, FirstName: sub.FirstName, LastName: sub.LastName }, OrgTeacher: { Id: teacher.Id }, SubstitutionNote: 'Klasa pracuje z podręcznikiem, strony 88–90.' });
        }
        return [lesson];
      });
    }
    return { Timetable: out };
  };

  const behaviour = [
    ...(semester(T) === 2 ? [{ Id: 1, Semester: '1', IsProposal: '0', GradeType: { Id: login === 'demo1' ? 1 : 2 } }] : [{ Id: 1, Semester: '1', IsProposal: '1', GradeType: { Id: 2 } }]),
    ...(month === 5 || month === 6 ? [{ Id: 2, Semester: '2', IsProposal: '1', GradeType: { Id: 1 } }] : []),
  ];

  const points = [[1, '15', back(9), 2, 'Konkurs matematyczny, etap szkolny'], [3, '-2', ago(3), s.tutor], [4, '5', back(14), s.tutor, 'Gazetka klasowa'], [2, '5', back(22), 11], [3, '-2', ago(12), s.tutor]].map(
    ([category, Value, Date, teacher, text], i) => ({ Id: i + 1, Category: { Id: category }, Value, Date, AddedBy: { Id: teacher }, Semester: semester(Date), text }),
  );

  const recent = grades.filter((g) => g.Category.Id < 8).sort((p, q) => q.AddDate.localeCompare(p.AddDate));
  const activity = [
    ...recent.slice(0, 3).map((g) => ({ at: unix(g.AddDate.slice(0, 10), g.AddDate.slice(11, 16)), kind: 'Grades', change: 'Add', resource: String(g.Id) })),
    { at: NOW - 86400 * 2, kind: 'Grades', change: 'Edit', resource: String(recent[Math.min(8, recent.length - 1)].Id) },
    ...messages.filter((m) => m.unread).map((m) => ({ at: m.at, kind: 'Messages', change: 'Add', resource: m.Id })),
    { at: unix(ago(3), '08:50'), kind: 'Attendances', change: 'Add', resource: `${ago(3)}/1` },
    { at: NOW - 86400, kind: 'Timetables', change: 'Edit', resource: String(lessonOf(on(next)[2])) },
    { at: NOW - 86400 * 3, kind: 'HomeWorks', change: 'Add', resource: String(tests[0].Id) },
    { at: unix(notes[0].Date, '13:00'), kind: 'Notes', change: 'Add', resource: String(notes[0].Id) },
    { at: unix(back(3), '10:00'), kind: 'SchoolNotices', change: 'Add', resource: '1' },
  ].sort((p, q) => q.at - p.at);

  const groups = {
    tutors: { Label: 'Wychowawcy', Receivers: [{ Id: s.tutor, Label: name(s.tutor) }] },
    teachers: {
      Label: 'Nauczyciele',
      ReceiversSubGroup: subjects.filter((x) => x !== 14).map((x) => ({ Label: SUBJECTS[x - 1].Name, Receivers: [{ Id: t[x], Label: name(t[x]) }] })),
    },
    office: { Label: 'Sekretariat', Receivers: [{ Id: 20, Label: 'Sekretariat' }] },
  };

  return {
    s, login, grades, comments, averages, attendances, messages, homework, calendar, notes, realizations, timetable, behaviour, points, activity, groups,
    other: s.systems && { ...other, whole },
    lucky: 1 + Math.floor(rnd() * 30),
  };
}

const name = (id) => {
  const u = USERS.find((x) => x.Id === id);
  return [u.FirstName, u.LastName].filter((x) => x !== 'null').join(' ');
};

const NOTICES = [
  { Id: 1, Subject: 'Zebrania z rodzicami', Content: 'Zebrania z rodzicami odbędą się o 17:30 w salach wychowawców. Prosimy o obecność.', StartDate: back(3), EndDate: ahead(8), AddedBy: { Id: 20 } },
  { Id: 2, Subject: 'Dzień otwarty szkoły', Content: 'Zapraszamy przyszłych uczniów i ich rodziców. Będzie można zwiedzić pracownie i porozmawiać z nauczycielami.', StartDate: back(10), AddedBy: { Id: 20 } },
  { Id: 3, Subject: 'Godziny pracy biblioteki', Content: 'Od poniedziałku biblioteka szkolna jest czynna od 7:30 do 15:30.', StartDate: back(20), AddedBy: { Id: 20 } },
  { Id: 4, Subject: 'Ubezpieczenie NNW', Content: 'Składki na ubezpieczenie NNW przyjmuje sekretariat do końca miesiąca.', StartDate: back(40), AddedBy: { Id: 20 } },
];
const ME = { email: 'rodzic@example.com', admin: true, push: '', accounts: Object.entries(STUDENTS).map(([login, s]) => ({ login, name: s.name, state: 'active' })) };
const ACCESS = { fixed: [ME.email], emails: [{ email: 'babcia.kowalczyk@example.com', added: NOW - 86400 * 30, active: true }] };
const accounts = new Map();
let logged = true;

const reply = (status, body) =>
  status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const list = (key, items) => ({ [key]: items });
const ids = (rest) => new Set(rest.split('/').at(-1).split(',').map(Number));
const file = () => ({ DownloadUrl: new URL('zalacznik.pdf', location.href).href });

/** One student's Synergia resource, GET or POST; null when Librus would not know it. */
function synergia(d, method, rest, query, body) {
  const { s } = d;
  const user = (id) => USERS.find((u) => u.Id === Number(id));
  if (method === 'POST') {
    if (rest === 'HomeWorkAssignments/MarkAsRead' || rest === 'HomeWorkAssignments/MarkAsDone') {
      const h = d.homework.find((x) => x.Id === body.homework);
      if (h) h[rest.endsWith('Read') ? 'read' : 'done'] = true;
      return { Status: 'OK' };
    }
    if (rest === 'Messages') {
      const to = body.originalMessageId ? [d.messages.find((m) => m.Id === String(body.originalMessageId))?.from ?? s.tutor] : (body.receivers ?? []).map(Number);
      const m = { Id: String(s.base + 100 + d.messages.length), to: to[0], receivers: to, at: Math.floor(Date.now() / 1000), subject: body.subject, body: String(body.body ?? '').replace(/\n/g, '<br>'), read: true };
      d.messages.unshift(m);
      return { Message: { Id: m.Id } };
    }
    return null;
  }
  const receivers = (m) => (m.receivers ?? [m.to]).map((Id) => ({ Id }));
  const message = (m) => ({
    Id: m.Id, Subject: m.subject, SendDate: m.at, Sender: { Id: m.to ? PARENT : m.from }, Receiver: m.to ? receivers(m) : [{ Id: PARENT }],
    ReadDates: [{ ReadDate: m.read ? m.at + 600 : 0 }], inSended: m.to ? '1' : '0', inTrash: '0',
  });
  const fixed = {
    Me: { Me: { Account: { Login: d.login, GroupId: 5, IsPremium: true } } },
    Subjects: list('Subjects', SUBJECTS),
    Users: list('Users', USERS),
    Lessons: list('Lessons', Object.entries(s.teachers).map(([subject, teacher]) => ({ Id: s.base + Number(subject), Subject: { Id: Number(subject) }, Teacher: { Id: teacher } }))),
    Grades: list('Grades', d.grades),
    'Grades/Categories': list('Categories', CATEGORIES),
    'Grades/Comments': list('Comments', d.comments),
    // A school that hides its averages sends none; the app counts them.
    'Grades/Averages': list('Averages', s.hidden ? [] : d.averages),
    // Other systems only where a school uses them: the rest Librus does not know, as for the first two children.
    ...(d.other && {
      PointGrades: list('Grades', d.other.points),
      'PointGrades/Categories': list('Categories', POINT_CATEGORIES),
      TextGrades: list('Grades', d.other.words),
      DescriptiveGrades: list('Grades', [...d.other.letters, ...d.other.described.map((g) => ({ ...g, Id: g.Id + 1000 }))]),
      'DescriptiveGrades/Skills': list('Skills', SKILLS),
      'DescriptiveGrades/Text': list('Grades', d.other.whole),
      'DescriptiveGrades/Text/Categories': list('Categories', WHOLE),
    }),
    Attendances: list('Attendances', d.attendances),
    'Attendances/Types': list('Types', [
      { Id: 1, Name: 'Nieobecność', Short: 'nb', Standard: true }, { Id: 2, Name: 'Spóźnienie', Short: 'sp', Standard: true },
      { Id: 3, Name: 'Nieobecność uspr.', Short: 'u', Standard: true }, { Id: 4, Name: 'Zwolnienie', Short: 'zw', Standard: true },
      { Id: 100, Name: 'Obecność', Short: 'ob', Standard: true },
      { Id: 51, Name: 'Zwolnienie na zawody', Short: 'zz', StandardType: { Id: 4 } },
    ]),
    LuckyNumbers: { LuckyNumber: { LuckyNumber: d.lucky, LuckyNumberDay: T } },
    'Messages/Unread': { UnreadMessages: d.messages.filter((m) => !m.read).length },
    'Messages/ReceiversGroup': list('ReceiversGroup', Object.keys(d.groups).map((Id) => ({ Id }))),
    HomeWorkAssignments: list('HomeWorkAssignments', d.homework.map(({ read, done, files, ...h }) => ({
      ...h, StudentsWhoRead: read ? [{ Id: s.user }] : [], StudentsWhoMarkedAsDone: done ? [{ Id: s.user }] : [], HomeworkAssigmentFiles: (files ?? []).map((Name, i) => ({ Id: i + 1, Name })),
    }))),
    Calendars: list('Calendars', [{ Id: 1 }]),
    'HomeWorks/Categories': list('Categories', [{ Id: 1, Name: 'Sprawdzian' }, { Id: 2, Name: 'Kartkówka' }, { Id: 3, Name: 'Projekt' }]),
    'Calendars/ClassFreeDays/Types': list('Types', [{ Id: 1, Name: 'Wycieczka klasowa' }]),
    SchoolNotices: list('SchoolNotices', NOTICES),
    Notes: list('Notes', d.notes),
    'Notes/Categories': list('Categories', ['Konkursy', 'Pomoc koleżeńska', 'Przygotowanie do lekcji', 'Zaangażowanie', 'Zachowanie na lekcji'].map((Name, i) => ({ Id: i + 1, Name }))),
    Realizations: list('Realizations', d.realizations),
    BehaviourGrades: list('Grades', d.behaviour),
    'BehaviourGrades/Types': list('Types', [{ Id: 1, Name: 'wzorowe' }, { Id: 2, Name: 'bardzo dobre' }, { Id: 3, Name: 'dobre' }]),
    'BehaviourGrades/Points': list('Grades', d.points.map(({ text, ...p }) => p)),
    'BehaviourGrades/Points/Categories': list('Categories', [
      { Id: 1, Name: 'Udział w konkursie', ValueFrom: 5, ValueTo: 20 }, { Id: 2, Name: 'Pomoc w organizacji imprezy', ValueFrom: 5, ValueTo: 5 },
      { Id: 3, Name: 'Spóźnienie', ValueFrom: -2, ValueTo: -2 }, { Id: 4, Name: 'Praca na rzecz klasy', ValueFrom: 5, ValueTo: 10 },
    ]),
    'BehaviourGrades/Points/Comments': list('Comments', d.points.filter((p) => p.text).map((p) => ({ Id: p.Id, Grade: { Id: p.Id }, Text: p.text }))),
    Classes: { Class: { Id: 1, Number: s.cls[0], Symbol: s.cls[1], ClassTutors: [{ Id: s.tutor }], Unit: { Id: 1 } } },
    Units: list('Units', [{ Id: 1, BehaviourGradesSettings: { StartPoints: { Semester1: s.start ?? 0 } } }]),
    Schools: { School: { Id: 1, Name: s.school ?? 'Szkoła Podstawowa nr 7 im. Jana Brzechwy', Street: 'Lipowa', BuildingNumber: '12', Town: 'Kraków' } },
  };
  if (rest in fixed) return fixed[rest];
  if (rest === 'Timetables') return d.timetable(query.get('weekStart'));
  if (rest === 'Messages') return list('Messages', query.get('page') === '1' ? d.messages.map(message) : []);
  if (rest.startsWith('Messages/User/')) return list('Users', [...ids(rest)].map(user).filter(Boolean));
  if (rest.startsWith('Messages/ReceiversGroup/')) return d.groups[rest.split('/')[2]] ? list('ReceiversGroup', [d.groups[rest.split('/')[2]]]) : null;
  if (rest.startsWith('Messages/Attachment/') || rest.startsWith('HomeWorkAssignments/Attachment/')) return file();
  if (/^Messages\/\d+$/.test(rest)) {
    const m = d.messages.find((x) => x.Id === rest.split('/')[1]);
    if (!m) return null;
    m.read = true;
    const files = (m.files ?? []).map((Name, i) => ({ Id: i + 1, Name }));
    return { Message: { ...message(m), Receivers: message(m).Receiver, Body: m.body, MessageFiles: files, AddedFiles: files.length ? '1' : '0' } };
  }
  if (rest.startsWith('Classrooms/')) return list('Classrooms', [...ids(rest)].map((Id) => ({ Id, Symbol: ROOMS[Id - 100] })));
  if (/^Calendars\/1$/.test(rest)) {
    const inMonth = (date) => parse(date).getFullYear() === Number(query.get('year')) && parse(date).getMonth() + 1 === Number(query.get('month'));
    return { Calendar: Object.fromEntries(Object.entries(d.calendar).map(([k, v]) => [k, v.filter((e) => inMonth(e.Date ?? e.DateFrom)).map((e) => ({ Id: e.Id }))])) };
  }
  for (const [path, key] of [['HomeWorks', 'HomeWorks'], ['Calendars/ClassFreeDays', 'ClassFreeDays'], ['Calendars/TeacherFreeDays', 'TeacherFreeDays'], ['Calendars/SchoolFreeDays', 'SchoolFreeDays'], ['ParentTeacherConferences', 'ParentTeacherConferences']])
    if (new RegExp(`^${path}/[\\d,]+$`).test(rest)) return list(key, d.calendar[key].filter((e) => ids(rest).has(e.Id)));
  return null;
}

/** What `fetch('/api/' + path, init)` would answer from the app's server. */
export function answer(path, init = {}) {
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : {};
  const [route, q = ''] = path.split('?');
  const query = new URLSearchParams(q);
  if (route === 'login' && method === 'POST') return ((logged = true), reply(200, ME));
  if (route === 'logout') return ((logged = false), reply(204));
  if (route === 'about') return reply(200, { operator: '', build: 'official', commit: '' });
  if (!logged) return reply(401, { error: 'unauthorized' });
  if (route === 'me') return method === 'DELETE' ? ((logged = false), reply(204)) : reply(200, ME);
  if (route === 'push') return method === 'GET' ? reply(200, { feeds: ME.accounts.map((a) => ({ login: a.login, checked: NOW - 300, error: '' })) }) : reply(204);
  if (route === 'admin/emails' && method === 'POST') {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { error: 'bad_email' });
    if (!ACCESS.emails.some((e) => e.email === email)) ACCESS.emails.unshift({ email, added: Math.floor(Date.now() / 1000), active: false });
    return reply(200, ACCESS);
  }
  if (route === 'admin/emails') return reply(200, ACCESS);
  if (route.startsWith('admin/emails/') && method === 'DELETE') {
    ACCESS.emails = ACCESS.emails.filter((e) => e.email !== decodeURIComponent(route.split('/')[2]));
    return reply(200, ACCESS);
  }
  const [kind, login, ...rest] = route.split('/');
  if (!Object.hasOwn(STUDENTS, decodeURIComponent(login ?? ''))) return reply(404, { error: 'not_found' });
  if (!accounts.has(login)) accounts.set(login, build(login));
  const d = accounts.get(login);
  if (kind === 'activity') return reply(200, { entries: d.activity });
  const out = kind === 's' ? synergia(d, method, rest.join('/'), query, body) : null;
  return out ? reply(200, out) : reply(404, { Status: 'Error', Code: 'NotFound' });
}
