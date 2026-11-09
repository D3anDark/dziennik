import { synergia, lookup, byId } from './api.svelte.js';
import { person, plain } from './util.js';

/** One timetable week: [{ date, lessons }] sorted, each lesson with `room` resolved. */
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
  for (const d of out) for (const l of d.lessons) l.room = rooms.get(String(l.Classroom?.Id))?.Symbol ?? '';
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
      when: [e.Time && e.Time !== '00:00:00' ? e.Time.slice(0, 5) : '', e.Room ? `sala ${e.Room}` : ''].filter(Boolean).join(', '),
      who: who(e.Teacher),
    })),
  ];
  return events
    .filter((e) => e.date)
    .map((e) => ({ ...e, to: e.to && e.to !== e.date ? e.to : '' }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
