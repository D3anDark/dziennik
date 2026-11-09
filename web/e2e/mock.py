import datetime as dt, json, sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

DIST, PORT = sys.argv[1], int(sys.argv[2])
STATE = {"logged": False, "log": []}
ME = {"email": "rodzic@example.com", "accounts": [
    {"login": "1001u", "name": "Jan Testowy", "state": "active"},
    {"login": "2002u", "name": "Ala Testowa", "state": "active"}]}

def lesson(no, frm, to, sid, name, room, **kw):
    return {"LessonNo": str(no), "HourFrom": frm, "HourTo": to, "Subject": {"Id": sid, "Name": name},
            "Teacher": {"FirstName": "Anna", "LastName": "Nowak"}, "Classroom": {"Id": room},
            "IsCanceled": kw.get("c", False), "IsSubstitutionClass": kw.get("s", False)}

def timetable(start):
    d0 = dt.date.fromisoformat(start)
    out = {}
    for i in range(7):
        day = (d0 + dt.timedelta(days=i)).isoformat()
        out[day] = [] if i >= 5 else [
            [lesson(1, "08:00", "08:45", "5", "Matematyka", "12")], [],
            [lesson(3, "09:50", "10:35", 7, "Język polski", 13, c=(i == 1))],
            [lesson(2, "08:55", "09:40", "9", "Fizyka", "12", s=(i == 2))]]
    return {"Timetable": out}

S = {
    "Grades": {"Grades": [
        {"Id": 1, "Grade": "5", "Date": "2026-10-01", "AddDate": "2026-10-01 10:00:00", "Semester": 1, "Subject": {"Id": 5}, "Category": {"Id": "1"}},
        {"Id": 2, "Grade": "4+", "Date": "2026-10-08", "AddDate": "2026-10-20 10:00:00", "Semester": "1", "Subject": {"Id": "5"}, "Category": {"Id": 2}, "AddedBy": {"Id": 1}},
        {"Id": 3, "Grade": "3", "Date": "2026-10-09", "Semester": 1, "Subject": {"Id": "7"}, "Category": {"Id": 1}},
        {"Id": 4, "Grade": "5", "Date": "2026-10-10", "Semester": 1, "Subject": {"Id": "5"}, "Category": {"Id": 3}},
        {"Id": 5, "Grade": "2", "Date": "2026-10-11", "Semester": 1, "Subject": {"Id": "404"}, "Category": {"Id": 1}},
        {"Id": 6, "Grade": "4", "Date": "2026-10-12", "Semester": 1, "Subject": {"Id": "405"}, "Category": {"Id": 1}}]},
    "Subjects": {"Subjects": [{"Id": 5, "Name": "Matematyka"}, {"Id": "7", "Name": "Język polski"}]},
    "Grades/Categories": {"Categories": [
        {"Id": 1, "Name": "Sprawdzian", "Weight": 3, "CountToTheAverage": True},
        {"Id": "2", "Name": "Kartkówka", "Weight": 2, "CountToTheAverage": True},
        {"Id": 3, "Name": "Ocena śródroczna", "IsSemestral": True}]},
    "Classrooms/12,7,13": {"Classrooms": [{"Id": "12", "Symbol": "104"}, {"Id": 13, "Symbol": "sala gim."}]},
    "Classrooms/12,13": {"Classrooms": [{"Id": "12", "Symbol": "104"}, {"Id": 13, "Symbol": "sala gim."}]},
    "Attendances": {"Attendances": [
        {"Id": "a1", "Date": "2026-10-01", "LessonNo": "1", "Type": {"Id": 100}, "Lesson": {"Id": 1}},
        {"Id": "a2", "Date": "2026-10-02", "LessonNo": "2", "Type": {"Id": "1"}, "Lesson": {"Id": 1}},
        {"Id": "a3", "Date": "2026-10-03", "LessonNo": "1", "Type": {"Id": 2}},
        {"Id": "a4", "Date": "2026-10-03", "LessonNo": "4", "Type": {"Id": 1}},
        {"Id": "a5", "Date": "2026-10-04", "LessonNo": "3", "Type": {"Id": 50}}]},
    "Attendances/Types": {"Types": [
        {"Id": 1, "Name": "Nieobecność", "Short": "nb", "Standard": True}, {"Id": 2, "Name": "Spóźnienie", "Short": "sp", "Standard": True},
        {"Id": 100, "Name": "Obecność", "Short": "ob", "Standard": True},
        {"Id": 50, "Name": "Obecność (zdalna)", "Short": "zd", "StandardType": {"Id": 100}}]},
    "LuckyNumbers": {"LuckyNumber": {"LuckyNumber": 13, "LuckyNumberDay": "2026-11-10"}},
    "Users": {"Users": [{"Id": 1, "FirstName": "Anna", "LastName": "Nowak"},
                        {"Id": "2", "FirstName": "Piotr", "LastName": "null"}]},
    "Lessons": {"Lessons": [{"Id": 1, "Subject": {"Id": 5}, "Teacher": {"Id": 1}},
                            {"Id": "2", "Subject": {"Id": "7"}, "Teacher": {"Id": 2}},
                            {"Id": 3, "Subject": {"Id": 5}, "Teacher": {"Id": "2"}}]},
    "Grades/Averages": {"Averages": [{"Subject": {"Id": 5}, "Semester1": "4.67", "Semester2": "0.00", "FullYear": "0.00"}]},
    "HomeWorks/Categories": {"Categories": [{"Id": 1, "Name": "Sprawdzian"}]},
    "Calendars/ClassFreeDays/Types": {"Types": [{"Id": 1, "Name": "Wycieczka klasowa"}]},
    "Calendars": {"Calendars": [{"Id": 7}]},
    "SchoolNotices": {"SchoolNotices": [
        {"Id": "n1", "Subject": "Zebranie", "Content": "Zapraszamy<br>rodzicow. https://example.com/z",
         "StartDate": "2026-11-05", "EndDate": "2026-11-20", "AddedBy": {"Id": 1}},
        {"Id": "n2", "Subject": "Starsze", "Content": "x", "StartDate": "2026-09-01", "AddedBy": {"Id": 99}}]},
    "Notes": {"Notes": [
        {"Id": 1, "Text": "Brak zadania", "Date": "2026-10-20", "Positive": 0, "Category": {"Id": 1}, "Teacher": {"Id": 1}},
        {"Id": 2, "Text": "Pomoc w konkursie", "Date": "2026-10-25", "Positive": "1", "Category": {"Id": 2}, "Teacher": {"Id": 2}}]},
    "Notes/Categories": {"Categories": [{"Id": 1, "Name": "Przygotowanie"}, {"Id": 2, "CategoryName": "Konkursy"}]},
    "BehaviourGrades": {"Grades": [
        {"Id": 1, "Semester": "1", "IsProposal": "0", "GradeType": {"Id": 3}},
        {"Id": 2, "Semester": "2", "IsProposal": "1", "GradeType": {"Id": 4}}]},
    "BehaviourGrades/Types": {"Types": [{"Id": 3, "Name": "bardzo dobre", "Shortcut": "bdb"},
                                        {"Id": 4, "Name": "wzorowe", "Shortcut": "wz"}]},
}

TODAY = dt.date.today()
def ahead(n): return (TODAY + dt.timedelta(days=n)).isoformat()
MSG_READ = {"11": False}
HW = {"read": {2}, "done": set()}
SENT = {}
GROUPS = {
    "tutors": {"Label": "Wychowawcy", "Receivers": [{"Id": 1, "Label": "Anna Nowak"}]},
    "teachers": {"Label": "Nauczyciele", "ReceiversSubGroup": [
        {"Label": "Matematyka", "Receivers": [{"Id": 1, "Label": "Anna Nowak"}, {"Id": "2", "Label": "Piotr Zielinski"}]}]},
}

def users_by(ids):
    known = {u["Id"] if isinstance(u["Id"], str) else str(u["Id"]): u for u in S["Users"]["Users"]}
    known["9"] = {"Id": 9, "FirstName": "Jan", "LastName": "Testowy"}
    return {"Users": [known[i] for i in ids.split(",") if i in known]}

def calendar(q):
    y, m = int(q["year"][0]), int(q["month"][0])
    inm = lambda d: dt.date.fromisoformat(d).year == y and dt.date.fromisoformat(d).month == m
    c = {"HomeWorks": [{"Id": 1}] if inm(ahead(2)) else [],
         "ClassFreeDays": [{"Id": 2}] if inm(ahead(5)) else [],
         "TeacherFreeDays": [{"Id": 3}] if inm(ahead(2)) else [],
         "SchoolFreeDays": [], "ParentTeacherConferences": [{"Id": 4}] if inm(ahead(20)) else []}
    return {"Calendar": c}

def dynamic(rest, q):
    if rest == "Calendars/7":
        return calendar(q)
    if rest == "HomeWorks/1":
        return {"HomeWork": {"Id": 1, "Date": ahead(2), "Category": {"Id": 1}, "Subject": {"Id": 5},
                             "Content": "Funkcje liniowe", "LessonNo": "3", "CreatedBy": {"Id": 1}}}
    if rest == "Calendars/ClassFreeDays/2":
        return {"ClassFreeDays": [{"Id": 2, "DateFrom": ahead(5), "DateTo": ahead(6), "Type": {"Id": 1}, "Name": "Krakow"}]}
    if rest == "Calendars/TeacherFreeDays/3":
        return {"TeacherFreeDay": {"Id": 3, "DateFrom": ahead(2), "DateTo": ahead(2), "Teacher": {"Id": 2}}}
    if rest == "ParentTeacherConferences/4":
        return {"ParentTeacherConferences": [{"Id": 4, "Date": ahead(20), "Name": "Wywiadowka", "Time": "17:00:00", "Teacher": {"Id": 1}}]}
    if rest == "HomeWorkAssignments":
        out = {"HomeWorkAssignments": [
            {"Id": 1, "Topic": "Wypracowanie", "Text": "Opis <b>postaci</b>. https://example.com/a",
             "Date": ahead(-3), "DueDate": ahead(3), "Lesson": {"Id": "2"}, "Teacher": {"Id": 2}},
            {"Id": 2, "Topic": "Stare", "Text": "", "Date": "2026-09-01", "DueDate": "2026-09-08", "Lesson": {"Id": 1}, "Teacher": {"Id": 1}}]}
        for h in out["HomeWorkAssignments"]:
            h["StudentsWhoRead"] = [{"Id": 9}] if h["Id"] in HW["read"] else []
            h["StudentsWhoMarkedAsDone"] = [{"Id": 9}] if h["Id"] in HW["done"] else []
        return out
    if rest == "Messages/Unread":
        return {"UnreadMessages": 0 if MSG_READ["11"] else 1}
    if rest == "Messages":
        if q.get("page") != ["1"]:
            return {"Messages": []}
        base = int(dt.datetime.combine(TODAY, dt.time(8)).timestamp())
        return {"Messages": [
            {"Id": "11", "Subject": json.dumps("Wycieczka"), "SendDate": base, "Sender": {"Id": 1}, "Receiver": [{"Id": 9}],
             "ReadDates": [{"ReadDate": 1 if MSG_READ["11"] else 0}], "inSended": "0", "inTrash": "0"},
            {"Id": "12", "Subject": json.dumps("Stara"), "SendDate": base - 86400 * 9, "Sender": {"Id": "2"}, "Receiver": [{"Id": 9}],
             "ReadDates": [{"ReadDate": base - 86400 * 8}], "inSended": 0, "inTrash": 0},
            {"Id": "13", "Subject": json.dumps("Kosz"), "SendDate": base, "Sender": {"Id": 1}, "Receiver": [{"Id": 9}],
             "ReadDates": [{"ReadDate": 0}], "inSended": "0", "inTrash": "1"},
            {"Id": "14", "Subject": json.dumps("Pytanie"), "SendDate": base - 3600, "Sender": {"Id": 9}, "Receiver": [{"Id": 1}],
             "ReadDates": [{"ReadDate": 0}], "inSended": "1", "inTrash": "0"}]}
    if rest == "Messages/11":
        MSG_READ["11"] = True
        return {"Message": {"Id": "11", "Subject": json.dumps("Wycieczka"), "SendDate": 1762675200, "Sender": {"Id": 1},
                            "Receivers": [{"Id": 9}], "AddedFiles": "1",
                            "Body": json.dumps("Dzien dobry,<br>szczegoly: https://example.com/x<img src=x onerror=\"window.pwned=1\"><script>window.pwned=2</script>")}}
    if rest == "Messages/ReceiversGroup":
        return {"ReceiversGroup": [{"Id": "tutors"}, {"Id": "teachers"}, {"Id": "parents"}, {"Id": "broken"}]}
    if rest.startswith("Messages/ReceiversGroup/") and rest.rsplit("/", 1)[1] in GROUPS:
        return {"ReceiversGroup": [GROUPS[rest.rsplit("/", 1)[1]]]}
    if rest.startswith("Messages/") and rest.rsplit("/", 1)[1] in SENT:
        m = SENT[rest.rsplit("/", 1)[1]]
        return {"Message": {"Id": "15", "Subject": json.dumps(m["subject"]), "SendDate": 1762675200, "Sender": {"Id": 9},
                            "Receivers": [{"Id": r} for r in m.get("receivers", [1])], "Body": json.dumps(m["body"])}}
    if rest.startswith("Messages/User/"):
        return users_by(rest.rsplit("/", 1)[1])
    return None

class H(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        p = urlsplit(self.path).path
        n = int(self.headers.get("content-length") or 0); body = json.loads(self.rfile.read(n) or b"{}")
        STATE["log"].append("POST " + p)
        if p == "/api/login":
            if body.get("password") != "dobre":
                return self.send(401, {"error": "bad_credentials"})
            STATE["logged"] = True; return self.send(200, ME)
        if p == "/api/logout":
            STATE["logged"] = False; self.send_response(204); self.end_headers(); return
        STATE["log"][-1] += " " + json.dumps(body, sort_keys=True)
        rest = p.split("/", 4)[4] if p.startswith("/api/s/") else ""
        if not STATE["logged"] or self.headers.get("content-type") != "application/json":
            return self.send(401, {"error": "unauthorized"})
        if rest in ("HomeWorkAssignments/MarkAsRead", "HomeWorkAssignments/MarkAsDone"):
            HW["read" if rest.endswith("Read") else "done"].add(body["homework"])
            return self.send(200, {"Status": "OK"})
        if rest == "Messages":
            if body.get("subject") == "blad":
                return self.send(400, {"Status": "Error", "MessagePL": "Odbiorca nie przyjmuje wiadomości."})
            SENT["15"] = body
            return self.send(200, {"Message": {"Id": 15}})
        self.send(404, {"error": "not_found"})
    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/__log":
            return self.send(200, STATE["log"])
        if u.path == "/__unread":
            MSG_READ["11"] = False
            return self.send(200, {})
        if not u.path.startswith("/api/"):
            return super().do_GET()
        STATE["log"].append("GET " + self.path)
        if not STATE["logged"]:
            return self.send(401, {"error": "unauthorized"})
        if u.path == "/api/me":
            return self.send(200, ME)
        parts = u.path.split("/", 4)
        if len(parts) == 5 and parts[2] == "s":
            rest = parts[4]
            if rest == "Timetables":
                return self.send(200, timetable(parse_qs(u.query)["weekStart"][0]))
            if rest in S:
                return self.send(200, S[rest])
            d = dynamic(rest, parse_qs(u.query))
            if d is not None:
                return self.send(200, d)
            if rest.startswith("BehaviourGrades/Points"):
                return self.send(403, {"error": "http_403"})
        self.send(404, {"error": "upstream"})

ThreadingHTTPServer(("127.0.0.1", PORT), partial(H, directory=DIST)).serve_forever()
