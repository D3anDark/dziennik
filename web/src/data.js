import { api, synergia, lookup, byId } from './api.svelte.js';
import { iso, fmtDate, person, plain, gradeTone, room, today, shift } from './util.js';

/**
 * Every grading system Synergia has. A school uses one or two and
 * refuses the rest. `ref` is the field of a grade that points into the `dict` dictionary. `short` systems grade
 * with words, shown as a two-letter chip. `whole` grades describe the pupil, not a subject.
 */
const SYSTEMS = [
  { path: 'Grades', ref: 'Category', dict: 'Grades/Categories', comments: 'Grades/Comments', averages: 'Grades/Averages' },
  { path: 'PointGrades', ref: 'Category', dict: 'PointGrades/Categories', comments: 'PointGrades/Comments', averages: 'PointGrades/Averages' },
  { path: 'TextGrades', ref: 'Category', dict: 'Grades/Categories', short: true },
  { path: 'DescriptiveGrades', ref: 'Skill', dict: 'DescriptiveGrades/Skills', comments: 'DescriptiveGrades/Comments' },
  { path: 'DescriptiveTextGrades', ref: 'Skill', dict: 'DescriptiveTextGrades/Skills', short: true },
  { path: 'DescriptiveGrades/Text', ref: 'GradeGroupId', dict: 'DescriptiveGrades/Text/Categories', short: true, whole: true },
];

// When a system last came back refused or empty, by "login/path". A school rarely takes up another system, so
// such a list is asked for again only after a while. Bounded: students times the six paths above.
const idle = new Map();
const RECHECK = 15 * 60 * 1000;

/** The grade says what it is itself (seen in live answers); the category flags are the fallback. */
function final(grade, category) {
  if (grade.IsFinal || category?.IsFinal) return 'Ocena roczna';
  if (grade.IsFinalProposition || category?.IsFinalProposition) return 'Proponowana roczna';
  if (grade.IsSemester || category?.IsSemestral) return 'Ocena semestralna';
  if (grade.IsSemesterProposition || category?.IsSemestralProposition) return 'Proponowana semestralna';
  return null;
}

// Loads in flight, by login: two panels of one screen asking at once share one.
const loading = new Map();

/** The ids of new grades already opened on this device, by login. Librus keeps no read state for grades. */
export const SEEN_PREFIX = 'seen-grades/';

function seenIds(login) {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_PREFIX + login) ?? '[]'));
  } catch {
    return new Set();
  }
}

function saveSeen(login, ids) {
  try {
    localStorage.setItem(SEEN_PREFIX + login, JSON.stringify([...ids]));
  } catch {
    // Storage blocked or full: the dots come back on the next load, nothing else is lost.
  }
}

/**
 * The grades that are new: added in the last 7 days and not opened yet on this device. What the dot on a chip
 * and "nowe oceny" on Start count. Opened ids out of the 7 days are dropped, so the list stays a week of grades.
 */
export function unseenGrades(login, items) {
  const since = shift(today(), -7);
  const recent = items.filter((g) => g.added.slice(0, 10) > since);
  const seen = seenIds(login);
  const kept = new Set(recent.filter((g) => seen.has(g.id)).map((g) => g.id));
  if (kept.size !== seen.size) saveSeen(login, kept);
  return new Set(recent.filter((g) => !kept.has(g.id)).map((g) => g.id));
}

/** A new grade opened: no longer new, here and on Start. */
export function markGradeSeen(login, id) {
  saveSeen(login, seenIds(login).add(id));
}

/**
 * Grades of every system the school uses: { items, averages } with averages keyed like `item.subject`.
 * Fails only when no system answered, with the first error that is not a plain refusal.
 */
export function grades(login) {
  if (!loading.has(login)) loading.set(login, loadGrades(login).finally(() => loading.delete(login)));
  return loading.get(login);
}

async function loadGrades(login) {
  const lists = await Promise.all(
    SYSTEMS.map(async (s) => {
      const key = `${login}/${s.path}`;
      if (Date.now() - (idle.get(key) ?? 0) < RECHECK) return [];
      try {
        const list = (await synergia(login, s.path)).Grades ?? [];
        if (!list.length) idle.set(key, Date.now());
        return list;
      } catch (e) {
        if (/^http_40[34]$/.test(e.message)) idle.set(key, Date.now());
        return e;
      }
    }),
  );
  if (lists.every((l) => l instanceof Error)) throw lists.find((e) => !/^http_40[34]$/.test(e.message)) ?? lists[0];
  const soft = () => ({});
  const [subjects, users] = await Promise.all([
    lookup(login, 'Subjects').then((r) => byId(r.Subjects)),
    lookup(login, 'Users').then((r) => byId(r.Users)),
  ]);
  const items = [];
  const averages = new Map();
  await Promise.all(
    SYSTEMS.map(async (s, i) => {
      if (!lists[i].length) return;
      const [d, c, a] = await Promise.all([
        s.dict ? lookup(login, s.dict) : {},
        s.comments ? synergia(login, s.comments).catch(soft) : {},
        s.averages ? synergia(login, s.averages).catch(soft) : {},
      ]);
      const [dict, comments] = [byId(d.Categories ?? d.Skills), byId(c.Comments)];
      // One average a subject: with grades in both systems, the 1 to 6 scale's, however the answers race.
      for (const av of a.Averages ?? []) if (s.path === 'Grades' || !averages.has(String(av.Subject?.Id))) averages.set(String(av.Subject?.Id), av);
      for (const gr of lists[i]) {
        const ref = gr[s.ref];
        const category = dict.get(String(ref?.Id ?? ref));
        const full = String(gr.Map ?? gr.RealGradeValue ?? gr.Grade ?? '');
        const kind = final(gr, category);
        // A semester or year grade is one line of its own and stays whole; the rest share a row of chips.
        const cut = s.short && full.length > 2 && !kind;
        // Points carry their maximum, so a 5 of 20 is not read as a 5 on the 1 to 6 scale beside it.
        const max = s.path === 'PointGrades' && full && category?.ValueTo != null ? `/${category.ValueTo}` : '';
        const value = cut ? full.slice(0, 2).toUpperCase() : full + max;
        items.push({
          id: `${s.path}/${gr.Id}`,
          subject: s.whole ? 'whole' : String(gr.Subject?.Id),
          name: s.whole ? 'Oceny opisowe' : (subjects.get(String(gr.Subject?.Id))?.Name ?? 'Inne'),
          value,
          // Only the 1 to 6 scale has colours that mean something.
          tone: s.path === 'Grades' ? gradeTone(value) : 'g0',
          text: [cut ? full : '', gr.Phrase].map(plain).filter(Boolean).join(' '),
          date: gr.Date ?? gr.AddDate,
          added: gr.AddDate ?? '',
          semester: s.whole ? 0 : Number(gr.Semester) === 2 ? 2 : 1,
          category: [category?.Name, category?.ValueTo != null && `${category.ValueFrom ?? 0}–${category.ValueTo} pkt`].filter(Boolean).join(', '),
          weight: category?.CountToTheAverage ? category.Weight : null,
          teacher: gr.AddedBy?.Id ? person(users.get(String(gr.AddedBy.Id))) : '',
          comment: (gr.Comments ?? []).map((x) => plain(comments.get(String(x.Id))?.Text)).filter(Boolean).join(' '),
          kind,
        });
      }
    }),
  );
  // The systems answer in any order; by date, a row of chips reads the same on every load.
  items.sort((p, q) => String(p.date ?? '').localeCompare(String(q.date ?? '')) || p.added.localeCompare(q.added) || p.id.localeCompare(q.id));
  return { items, averages };
}

/** What a substitution or a move changed, from the Org* and New* fields of the lesson. */
function change(l, date, users, subjects) {
  const now = [l.Subject?.Name, l.Teacher && person(l.Teacher)];
  const names = (subject, teacher) =>
    [subjects.get(String(subject?.Id))?.Name, users.has(String(teacher?.Id)) && person(users.get(String(teacher.Id)))]
      .filter((x) => x && !now.includes(x))
      .join(', ');
  const [was, next] = [names(l.OrgSubject, l.OrgTeacher), names(l.NewSubject, l.NewTeacher)];
  return [
    was && `zamiast: ${was}`,
    next && `zmiana na: ${next}`,
    l.OrgDate && l.OrgDate !== date && `przeniesiona z ${fmtDate(l.OrgDate)}`,
    l.NewDate && l.NewDate !== date && `przeniesiona na ${fmtDate(l.NewDate)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** What a change is called (new, changed, removed) and where it shows, by the resource type of the change feed. */
const term = ['Nowy termin', 'Zmieniony termin', 'Usunięty termin', 'terminarz'];
const plan = ['Zmiana w planie lekcji', 'Zmiana w planie lekcji', 'Zmiana w planie lekcji', 'plan'];
const NEWS = {
  ...Object.fromEntries([...SYSTEMS.map((s) => s.path), 'PartialDescriptiveGrades'].map((p) => [p, ['Nowa ocena', 'Zmieniona ocena', 'Usunięta ocena', 'oceny']])),
  BehaviourGrades: ['Nowa ocena z zachowania', 'Zmieniona ocena z zachowania', 'Usunięta ocena z zachowania', 'zachowanie'],
  'BehaviourGrades/Points': ['Nowy wpis z zachowania', 'Zmieniony wpis z zachowania', 'Usunięty wpis z zachowania', 'zachowanie'],
  Attendances: ['Nowy wpis we frekwencji', 'Zmieniony wpis we frekwencji', 'Usunięty wpis we frekwencji', 'frekwencja'],
  Notes: ['Nowa uwaga', 'Zmieniona uwaga', 'Usunięta uwaga', 'uwagi'],
  Messages: ['Nowa wiadomość', 'Zmieniona wiadomość', 'Usunięta wiadomość', 'wiadomosci'],
  SchoolNotices: ['Nowe ogłoszenie', 'Zmienione ogłoszenie', 'Usunięte ogłoszenie', 'ogloszenia'],
  HomeWorkAssignments: ['Nowe zadanie domowe', 'Zmienione zadanie domowe', 'Usunięte zadanie domowe', 'zadania'],
  HomeWorks: term,
  ParentTeacherConferences: term,
  'Calendars/ClassFreeDays': term,
  'Calendars/TeacherFreeDays': term,
  'Calendars/SchoolFreeDays': term,
  'Calendars/Substitutions': plan,
  Timetables: plan,
};

/**
 * What changed for the student, newest first, as the server collected it from the Librus change feed:
 * [{ key, at, text, page, grade }]. A new or changed grade that still exists comes with its value and subject.
 */
export async function activity(login) {
  const [{ entries }, marks, me] = await Promise.all([
    api(`activity/${encodeURIComponent(login)}`),
    grades(login).then((g) => new Map(g.items.map((x) => [x.id, x])), () => new Map()),
    lookup(login, 'Me'),
  ]);
  // Only an account with Mobilne Dodatki reads messages by their API id; the rest go through the website (webmail.js).
  const paid = Boolean(me.Me?.Account?.IsPremium || me.Me?.Account?.IsPremiumDemo);
  return entries.flatMap((e, i) => {
    const words = NEWS[e.kind];
    if (!words) return [];
    const [text, page] = [words[['Add', 'Edit', 'Delete'].indexOf(e.change)], words[3]];
    // A new message opens itself.
    const one = paid && e.kind === 'Messages' && e.change === 'Add' && /^\d+$/.test(e.resource);
    return text ? [{ key: `${e.at}/${i}`, at: e.at, text, gone: e.change === 'Delete', page: one ? `${page}/${e.resource}` : page, grade: marks.get(`${e.kind}/${e.resource}`) }] : [];
  });
}

/**
 * The day worth looking at, out of `week()` days: today while a lesson is on or still ahead, otherwise the next
 * day with lessons. Null when the rest of the week has none. The device clock decides.
 */
export function upcomingDay(days, now = new Date()) {
  const [date, time] = [iso(now), now.toTimeString().slice(0, 5)];
  const ahead = (d) => d.lessons.some((l) => !l.IsCanceled && (d.date > date || l.HourTo > time));
  return days.find((d) => d.date >= date && ahead(d)) ?? null;
}

/** One timetable week: [{ date, lessons }] sorted, each lesson with `room`, `change` and the teacher's `note` resolved. */
export async function week(login, weekStart) {
  const t = (await synergia(login, `Timetables?weekStart=${weekStart}`)).Timetable ?? {};
  const out = Object.keys(t)
    .sort()
    .map((date) => ({
      date,
      lessons: (t[date] ?? [])
        .flat()
        .filter(Boolean)
        .sort((a, b) => Number(a.LessonNo) - Number(b.LessonNo)),
    }));
  const ids = [...new Set(out.flatMap((d) => d.lessons.map((l) => l.Classroom?.Id)).filter(Boolean))];
  // Room symbols are a nicety: on failure the plan still renders without them.
  const rooms = ids.length
    ? await synergia(login, `Classrooms/${ids.join(',')}`).then(
        (r) => byId(r.Classrooms ?? [r.Classroom]),
        () => new Map(),
      )
    : new Map();
  // Names behind the Org*/New* references; most weeks have none, so the dictionaries load only when needed.
  const refs = out.some((d) => d.lessons.some((l) => l.OrgSubject || l.OrgTeacher || l.NewSubject || l.NewTeacher));
  const [users, subjects] = refs
    ? await Promise.all([lookup(login, 'Users').then((r) => byId(r.Users)), lookup(login, 'Subjects').then((r) => byId(r.Subjects))])
    : [new Map(), new Map()];
  for (const d of out) {
    for (const l of d.lessons) {
      l.room = rooms.get(String(l.Classroom?.Id))?.Symbol ?? '';
      l.change = change(l, d.date, users, subjects);
      l.note = plain(l.SubstitutionNote);
    }
  }
  return out;
}

/** Fetches records listed in the month calendar by id; a comma list may come back under either key. */
async function byIds(login, refs, path, plural, single) {
  const ids = (refs ?? []).map((x) => x.Id).join(',');
  if (!ids) return [];
  const r = await synergia(login, `${path}/${ids}`);
  return r[plural] ?? (r[single] ? [r[single]] : []);
}

/**
 * Calendar entries of one month (month is 1..12):
 * the month object lists ids, details come per type.
 * Returns [{ id, date, to, kind, title, detail, who }] sorted by date.
 */
export async function monthEvents(login, year, month) {
  const cal = (await lookup(login, 'Calendars')).Calendars?.[0];
  if (!cal) return [];
  const c = (await synergia(login, `Calendars/${cal.Id}?month=${month}&year=${year}`)).Calendar ?? {};
  const [hw, cfd, tfd, sfd, ptc, users, subjects, cats, cfdTypes] = await Promise.all([
    byIds(login, c.HomeWorks, 'HomeWorks', 'HomeWorks', 'HomeWork'),
    byIds(login, c.ClassFreeDays, 'Calendars/ClassFreeDays', 'ClassFreeDays', 'ClassFreeDay'),
    byIds(login, c.TeacherFreeDays, 'Calendars/TeacherFreeDays', 'TeacherFreeDays', 'TeacherFreeDay'),
    byIds(login, c.SchoolFreeDays, 'Calendars/SchoolFreeDays', 'SchoolFreeDays', 'SchoolFreeDay'),
    byIds(login, c.ParentTeacherConferences, 'ParentTeacherConferences', 'ParentTeacherConferences', 'ParentTeacherConference'),
    lookup(login, 'Users').then((r) => byId(r.Users)),
    lookup(login, 'Subjects').then((r) => byId(r.Subjects)),
    lookup(login, 'HomeWorks/Categories').then((r) => byId(r.Categories)),
    lookup(login, 'Calendars/ClassFreeDays/Types').then((r) => byId(r.Types)),
  ]);
  const who = (ref) => (ref?.Id ? person(users.get(String(ref.Id))) : '');
  const hours = (from, to) => (from ? `${from.slice(0, 5)}${to ? `–${to.slice(0, 5)}` : ''}` : '');
  const events = [
    ...hw.map((e) => ({
      id: `hw${e.Id}`,
      date: e.Date,
      kind: 'event',
      title: [cats.get(String(e.Category?.Id))?.Name ?? 'Wydarzenie', subjects.get(String(e.Subject?.Id))?.Name]
        .filter(Boolean)
        .join(': '),
      detail: plain(e.Content),
      when: e.LessonNo ? `lekcja ${e.LessonNo}` : hours(e.TimeFrom, e.TimeTo),
      who: who(e.CreatedBy),
    })),
    ...cfd.map((e) => ({
      id: `cfd${e.Id}`,
      date: e.DateFrom,
      to: e.DateTo,
      kind: 'free',
      title: cfdTypes.get(String(e.Type?.Id))?.Name ?? 'Dzień wolny klasy',
      detail: plain(e.Name),
    })),
    ...sfd.map((e) => ({ id: `sfd${e.Id}`, date: e.DateFrom, to: e.DateTo, kind: 'free', title: plain(e.Name) || 'Dzień wolny' })),
    ...tfd.map((e) => ({
      id: `tfd${e.Id}`,
      date: e.DateFrom,
      to: e.DateTo,
      kind: 'teacher',
      title: `Nieobecność nauczyciela: ${who(e.Teacher)}`,
      when: hours(e.TimeFrom, e.TimeTo),
    })),
    ...ptc.map((e) => ({
      id: `ptc${e.Id}`,
      date: e.Date,
      kind: 'meeting',
      title: plain(e.Name) || 'Wywiadówka',
      detail: plain(e.Topic),
      when: [e.Time && e.Time !== '00:00:00' ? e.Time.slice(0, 5) : '', e.Room ? room(e.Room) : ''].filter(Boolean).join(' · '),
      who: who(e.Teacher),
    })),
  ];
  return events
    .filter((e) => e.date)
    .map((e) => ({ ...e, to: e.to && e.to !== e.date ? e.to : '' }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
