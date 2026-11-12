import datetime as dt, json, re, sys, time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, unquote

DIST, PORT = sys.argv[1], int(sys.argv[2])
STATE = {"logged": False, "log": []}
ME = {"email": "rodzic@example.com", "admin": True, "push": "BAAA" + "A" * 83, "accounts": [
    {"login": "1001u", "name": "Jan Testowy", "state": "active"},
    {"login": "2002u", "name": "Ala Testowa", "state": "active"}]}
ACCESS = {"fixed": ["rodzic@example.com"], "emails": [{"email": "ala@example.com", "added": 1762675200, "active": True}]}
FEEDS = {"feeds": [{"login": "1001u", "checked": 1762675200, "error": ""}, {"login": "2002u", "checked": 1762675200, "error": "relogin"}],
         "devices": [{"endpoint": "https://fcm.googleapis.com/fcm/send/e2e", "off": ["przerwy"], "quiet": ""}]}
# The second student: no Mobilne Dodatki, and a school that also grades with points, words and descriptions.
OTHER = {
    "Me": {"Me": {"Account": {"Login": "2002u", "GroupId": 5, "IsPremium": False, "IsPremiumDemo": False}}},
    "PointGrades": {"Grades": [{"Id": 1, "Subject": {"Id": "7"}, "Category": {"Id": 9}, "AddedBy": {"Id": 1}, "Grade": "5",
                                "Date": "2026-10-20", "AddDate": "2026-10-20 10:00:00", "Semester": 1, "Comments": [{"Id": 4}]},
                               # A subject graded in points alone: 15 of 20 and 9 of 10, the number given either way.
                               {"Id": 2, "Subject": {"Id": 12}, "Category": {"Id": 9}, "AddedBy": {"Id": 1}, "Grade": "15", "GradeValue": 15,
                                "Date": "2026-10-15", "AddDate": "2026-10-15 10:00:00", "Semester": 1},
                               {"Id": 3, "Subject": {"Id": 12}, "Category": {"Id": 10}, "AddedBy": {"Id": 1}, "Grade": "9",
                                "Date": "2026-10-16", "AddDate": "2026-10-16 10:00:00", "Semester": 1}]},
    "PointGrades/Categories": {"Categories": [{"Id": 9, "Name": "Sprawdzian", "ValueFrom": 0, "ValueTo": 20, "Weight": 1},
                                              {"Id": 10, "Name": "Kartkówka", "ValueFrom": 0, "ValueTo": 10, "Weight": 1}]},
    "PointGrades/Comments": {"Comments": [{"Id": 4, "Text": "Brawo"}]},
    "PointGrades/Averages": {"Averages": [{"Subject": {"Id": 7}, "Semester1": "71.50", "Semester2": "0.00", "FullYear": "0.00"}]},
    "TextGrades": {"Grades": [{"Id": 1, "Subject": {"Id": 5}, "AddedBy": {"Id": 2}, "Grade": "zaliczono",
                               "Date": "2026-10-21", "AddDate": "2026-10-21 10:00:00", "Semester": 2},
                              {"Id": 2, "Subject": {"Id": "7"}, "AddedBy": {"Id": 2}, "Grade": "zwolniony", "IsSemester": True,
                               "Date": "2026-10-24", "AddDate": "2026-10-24 10:00:00", "Semester": 1},
                              {"Id": 3, "Subject": {"Id": 11}, "Category": {"Id": 4}, "AddedBy": {"Id": 1}, "Grade": "5",
                               "Date": "2026-10-06", "AddDate": "2026-10-06 10:00:00", "Semester": 1},
                              {"Id": 4, "Subject": {"Id": 11}, "Category": {"Id": 4}, "AddedBy": {"Id": 1}, "Grade": "4",
                               "Date": "2026-10-07", "AddDate": "2026-10-07 10:00:00", "Semester": 1}]},
    "DescriptiveGrades": {"Grades": [{"Id": 1, "Subject": {"Id": 5}, "Skill": {"Id": 3}, "AddedBy": {"Id": 1}, "Map": "B",
                                      "Phrase": "Czyta płynnie", "Date": "2026-10-22", "AddDate": "2026-10-22 10:00:00", "Semester": 2},
                                     # A 1 to 6 grade kept as a descriptive one: Librus counts no average from it.
                                     {"Id": 2, "Subject": {"Id": 5}, "Skill": {"Id": 3}, "AddedBy": {"Id": 1}, "Map": "3",
                                      "Date": "2026-10-25", "AddDate": "2026-10-25 10:00:00", "Semester": 2}]},
    "DescriptiveGrades/Skills": {"Skills": [{"Id": 3, "Name": "Czytanie"}]},
    "DescriptiveGrades/Text": {"Grades": [{"Id": 1, "GradeGroupId": 8, "Grade": "Uczeń pracuje wytrwale.", "AddedBy": {"Id": 1},
                                           "AddDate": "2026-10-23 10:00:00"}]},
    "DescriptiveGrades/Text/Categories": {"Categories": [{"Id": 8, "Name": "Ocena śródroczna"}]},
    # Behaviour entries as a real school sends them: a symbol without points next to one with points.
    "BehaviourGrades/Points": {"Grades": [
        {"Id": 1, "Category": {"Id": 1}, "ShortName": "WC", "Date": "2026-10-05", "AddedBy": {"Id": 1}, "Comments": [{"Id": 7}], "Semester": 1},
        {"Id": 2, "Category": {"Id": 2}, "Value": "5", "Date": "2026-10-12", "AddedBy": {"Id": 1}, "Semester": 1}]},
    "BehaviourGrades/Points/Categories": {"Categories": [{"Id": 1, "Name": "Wagary", "ValueFrom": -10, "ValueTo": -5},
                                                         {"Id": 2, "Name": "Konkurs", "ValueFrom": 5, "ValueTo": 5}]},
    "BehaviourGrades/Points/Comments": {"Comments": [{"Id": 7, "Grade": {"Id": 1}, "Text": "Dwie godziny"}]},
}

def lesson(no, frm, to, sid, name, room, **kw):
    return {"LessonNo": str(no), "HourFrom": frm, "HourTo": to, "Subject": {"Id": sid, "Name": name},
            "Teacher": {"FirstName": "Anna", "LastName": "Nowak"}, "Classroom": {"Id": room},
            "IsCanceled": kw.get("c", False), "IsSubstitutionClass": kw.get("s", False), **kw.get("x", {})}

def timetable(start):
    d0 = dt.date.fromisoformat(start)
    out = {}
    for i in range(7):
        day = (d0 + dt.timedelta(days=i)).isoformat()
        out[day] = [] if i >= 5 else [
            [lesson(1, "08:00", "08:45", "5", "Matematyka", "12")], [],
            [lesson(3, "09:50", "10:35", 7, "Język polski", 13, c=(i == 1))],
            [lesson(2, "08:55", "09:40", "9", "Fizyka", "12", s=(i == 2), x={} if i != 2 else {
                "OrgSubject": {"Id": "7"}, "OrgTeacher": {"Id": 2}, "SubstitutionNote": "Przynieście zeszyty"})]]
    return {"Timetable": out}

S = {
    "Grades": {"Grades": [
        {"Id": 1, "Grade": "5", "Date": "2026-10-01", "AddDate": "2026-10-01 10:00:00", "Semester": 1, "Subject": {"Id": 5}, "Category": {"Id": "1"}},
        {"Id": 2, "Grade": "4+", "Date": "2026-10-08", "AddDate": "2026-10-20 10:00:00", "Semester": "1", "Subject": {"Id": "5"}, "Category": {"Id": 2}, "AddedBy": {"Id": 1}},
        {"Id": 3, "Grade": "3", "Date": "2026-10-09", "Semester": 1, "Subject": {"Id": "7"}, "Category": {"Id": 1}},
        {"Id": 4, "Grade": "5", "Date": "2026-10-10", "Semester": 1, "Subject": {"Id": "5"}, "Category": {"Id": 3}},
        {"Id": 5, "Grade": "2", "Date": "2026-10-11", "Semester": 1, "Subject": {"Id": "404"}, "Category": {"Id": 1}},
        {"Id": 6, "Grade": "4", "Date": "2026-10-12", "Semester": 1, "Subject": {"Id": "405"}, "Category": {"Id": 1}},
        # Improvements, the link on the newer grade: of a test not written ("-"), and of the 2 above.
        {"Id": 7, "Grade": "-", "Date": "2026-10-05", "Semester": 1, "Subject": {"Id": "405"}, "Category": {"Id": 1}},
        {"Id": 8, "Grade": "3", "Date": "2026-10-13", "Semester": 1, "Subject": {"Id": "405"}, "Category": {"Id": 1},
         "Improvement": {"Id": 7, "Url": "https://api.librus.pl/2.0/Grades/7"}},
        {"Id": 9, "Grade": "4", "Date": "2026-10-14", "Semester": 1, "Subject": {"Id": "404"}, "Category": {"Id": 2},
         "Improvement": {"Id": 5, "Url": "https://api.librus.pl/2.0/Grades/5"}}]},
    "Subjects": {"Subjects": [{"Id": 5, "Name": "Matematyka"}, {"Id": "7", "Name": "Język polski"}, {"Id": 11, "Name": "Statystyka"},
                              {"Id": 12, "Name": "Chemia"}]},
    "Me": {"Me": {"Account": {"Login": "1001u", "GroupId": 8, "IsPremium": True}}},
    "Grades/Categories": {"Categories": [
        {"Id": 1, "Name": "Sprawdzian", "Weight": 3, "CountToTheAverage": True},
        {"Id": "2", "Name": "Kartkówka", "Weight": 2, "CountToTheAverage": True},
        {"Id": 3, "Name": "Ocena śródroczna", "IsSemestral": True},
        # Counted, at no weight: how some schools keep a subject out of the average.
        {"Id": 4, "Name": "Aktywność", "Weight": 0, "CountToTheAverage": True}]},
    "Classrooms/12,7,13": {"Classrooms": [{"Id": "12", "Symbol": "104"}, {"Id": 13, "Symbol": "sala gim."}]},
    "Classrooms/12,13": {"Classrooms": [{"Id": "12", "Symbol": "104"}, {"Id": 13, "Symbol": "sala gim."}]},
    "Attendances": {"Attendances": [
        {"Id": "a1", "Date": "2026-10-01", "LessonNo": "1", "Type": {"Id": 100}, "Lesson": {"Id": 1}},
        {"Id": "a2", "Date": "2026-10-02", "LessonNo": "2", "Type": {"Id": "1"}, "Lesson": {"Id": 1}},
        {"Id": "a3", "Date": "2026-10-03", "LessonNo": "1", "Type": {"Id": 2}},
        {"Id": "a4", "Date": "2026-10-03", "LessonNo": "4", "Type": {"Id": 3}},
        {"Id": "a5", "Date": "2026-10-04", "LessonNo": "3", "Type": {"Id": 50}}]},
    "Attendances/Types": {"Types": [
        {"Id": 1, "Name": "Nieobecność", "Short": "nb", "Standard": True}, {"Id": 2, "Name": "Spóźnienie", "Short": "sp", "Standard": True},
        {"Id": 3, "Name": "Nieobecność uspr.", "Short": "u", "Standard": True}, {"Id": 4, "Name": "Zwolnienie", "Short": "zw", "Standard": True},
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
# The 4+ was added yesterday: a new grade, with its dot until opened.
S["Grades"]["Grades"][1]["AddDate"] = f"{ahead(-1)} 10:00:00"
MSG_READ = {"11": False}
HW = {"read": {2}, "done": set()}
SENT = {}
GROUPS = {
    "tutors": {"Label": "Wychowawcy", "Receivers": [{"Id": 1, "Label": "Anna Nowak"}]},
    "teachers": {"Label": "Nauczyciele", "ReceiversSubGroup": [
        {"Label": "Matematyka", "Receivers": [{"Id": 1, "Label": "Anna Nowak"}, {"Id": "2", "Label": "Piotr Zielinski"}]}]},
}

# The message module of the Synergia website, in the markup the real one had in November 2026.
WEB_READ = {"301": False}
# Messages sent through the site's form: (id, recipients, subject, body, date), newest first.
WEB_SENT = []
WEB_PEOPLE = {"wychowawca": [("1000001", "Nowak Anna")], "nauczyciel": [("1000001", "Nowak Anna"), ("1000002", "Zieliński Piotr")]}
WEB_FORM = ('<FORM ACTION="/wiadomosci" NAME="formWiadomosci" ID="formWiadomosci" enctype="multipart/form-data" METHOD="POST">'
            '<input type="hidden" name="requestkey" value="{key}" /><input type="hidden" name="filtrUzytkownikow" id="filtrUzytkownikow" value="0" />'
            '<input type="hidden" name="idPojemnika" value="" />{fields}<input type="HIDDEN" name="poprzednia" value="5">{more}'
            '<input type="hidden" name="fileStorageIdentifier" id="fileStorageUniqueId" value=""/>'
            '<INPUT TYPE="submit" VALUE="Wyślij" NAME="wyslij" TABINDEX="5" id="sendButton" class="medium" /></FORM>')

def web_radio(kind, label, args="false, 0 "):
    return (f"""<input type="radio" name="adresat" id="radio_{kind}" value="{kind}" onClick='selectRecipients("{kind}", {args});' class="recipiantTypeRadio" />"""
            f'<label for="radio_{kind}">{label}</label>')

def web_recipients(kind):
    if kind not in WEB_PEOPLE:
        return '<hr class="message-block-separator"><table class="message-recipients-options"><tr><td><select name="idGrupy" id="idGrupy"><option value="0"></option></select></td></tr></table>'
    rows = "".join(f'<tr class="line0"> <td class="center micro"> <input type="checkbox" value="{i}" id="check_{i}" name="DoKogo[]" >'
                   f'<input type="hidden" name="DoKogo_hid[]" value="{i}"></td> <td> <label class="d-flex flex-align-center gap-1" for="check_{i}">'
                   f'<span>{name}</span></label> </td> <td class="center">1</td> </tr>' for i, name in WEB_PEOPLE[kind])
    return ('<table class="message-recipients-detail " ><thead> <tr> <td><input name="zaznacz_wszystkie" type="checkbox"></td> <td>Nauczyciel</td>'
            f' <td>Nr</td> </tr> </thead>{rows}<tfoot><tr><td colspan=3>&nbsp;</td></tr></table>')

def web_post(path, fields):
    """What the site does with a submitted form; `fields` are the [name, value] pairs the app collected."""
    one = dict(fields)
    many = lambda name: [v for k, v in fields if k == name]
    if path == "getRecipients":
        return {"html": web_recipients(one.get("typAdresata"))}
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    names = dict(p for people in WEB_PEOPLE.values() for p in people)
    ok = one.get("wyslij") == "Wyślij" and one.get("temat") and one.get("tresc") and one.get("temat") != "blad"
    if path == "wiadomosci/5" and ok and one.get("requestkey") == "KEY-NEW" and many("DoKogo[]") \
            and many("DoKogo_hid[]") == [i for i, _ in WEB_PEOPLE.get(one.get("adresat"), [])]:
        WEB_SENT.insert(0, (401 + len(WEB_SENT), ", ".join(names[i] for i in many("DoKogo[]")), one["temat"], one["tresc"], now))
        return {"html": ""}
    if path == "wiadomosci" and ok and one.get("requestkey") == "KEY-REPLY" and one.get("typ") == "odp" and one.get("idWiadomosciOrg") == "301":
        WEB_SENT.insert(0, (401 + len(WEB_SENT), names[one["DoKogo"]], one["temat"], one["tresc"], now))
        return {"html": ""}
    # A form the site does not accept comes back as a page, and nothing is sent.
    return {"html": web_shell("<p>Nie wysłano.</p>")} if path in ("wiadomosci/5", "wiadomosci") else None

def web_shell(inner):
    unread = "" if WEB_READ["301"] else " (1)"
    return ('<html><body><table class="stretch container-message"><tr><td class="message-folders"><table class="message-folders">'
            f'<tr><td><a href="/wiadomosci/5">odebrane{unread}</a></td></tr><tr><td><a href="/wiadomosci/6">wysłane</a></td></tr>'
            f'</table></td><td>{inner}</td></tr></table></body></html>')

def web_row(folder, mid, who, title, date, unread=False, files=False):
    bold = ' style="font-weight: bold;"' if unread else ""
    icon = '<img src="/assets/img/attachment.png" class="tooltip" />' if files else ""
    link = f'/wiadomosci/1/{folder}/{mid}/f0'
    return (f'<tr class="line0"><td class="micro center"><input class="wiadomoscLista" type="checkbox" value="{mid}" name="wiadomosci[]" ></td>'
            f'<td class="micro center">{icon}</td><td{bold} ><a href="{link}">{who}</a></td><td{bold} ><a href="{link}">{title}</a></td>'
            f'<td class="medium center"{bold} >{date}</td><td class="micro center"></td></tr>')

def web_list(who, rows):
    return web_shell('<table class="decorated stretch"><thead><tr><td class="micro"></td><td class="micro">&nbsp;</td>'
                     f'<td><a href="javascript:void(0);">{who}</a></td><td>Temat</td><td>Wysłano</td><td class="micro">&nbsp;</td></tr></thead>'
                     f'<tbody>{"".join(rows)}</tbody><tfoot><tr><td colspan="6">&nbsp;</td></tr></tfoot></table>')

def web_message(rows, content, after):
    head = "".join(f'<tr><td class="medium left"><b>{k}</b></td><td class="left">{v}</td></tr>' for k, v in rows)
    return web_shell(f'<table class="stretch">{head}</table><div class="container-message-content">{content}</div>{after}')

def website(path):
    if path == "wiadomosci/5":
        return {"html": web_list("Nadawca", [
            web_row(5, 301, "Nowak Anna (nauczyciel)", "Zebranie", "2026-11-09 08:15:00", unread=not WEB_READ["301"]),
            web_row(5, 300, "Zieliński Piotr", "Regulamin", "2026-11-02 10:00:00", files=True)])}
    if path == "wiadomosci/6":
        return {"html": web_list("Adresat", [web_row(6, i, who, title, date) for i, who, title, _, date in WEB_SENT]
                                 + [web_row(6, 400, "Nowak Anna (nauczyciel)", "Pytanie o wycieczkę", "2026-11-03 17:30:00")])}
    if path == "wiadomosci/2/5":
        radios = (web_radio("wychowawca", "Wychowawcy") + web_radio("rada_rodzicow", "Rada klasowa rodzic&oacute;w", "false, 0 , 58899")
                  + web_radio("nauczyciel", "Nauczyciele") + web_radio("grupa", "Grupa adresat&oacute;w"))
        return {"html": web_shell(WEB_FORM.format(key="KEY-NEW", fields=radios + '<input type="hidden" name="Rodzaj" value="0" />'
                                                  '<input type="text" name="temat" id="temat" class="stretch" ><TEXTAREA NAME="tresc" id="tresc_wiadomosci"></TEXTAREA>', more=""))}
    if path == "wiadomosci/3/5/301":
        # The reply form is the one page of the module without the folder list around it.
        return {"html": "<html><body>" + WEB_FORM.format(
            key="KEY-REPLY", fields='<input type="text" name="temat" id="temat" value="Re: Zebranie" class="stretch" >'
            '<TEXTAREA NAME="tresc" id="tresc_wiadomosci">\n\n\n-----\nUżytkownik: Nowak Anna napisał:\nDzień dobry</TEXTAREA>',
            more='<input type="HIDDEN" name="DoKogo" value="1000001"><input type="HIDDEN" name="Wid" value="301">'
            '<input type="HIDDEN" name="idWiadomosciOrg" value="301"><input type="HIDDEN" name="idOdpowiadajacego" value="0">'
            '<input type="HIDDEN" name="typ" value="odp">') + "</body></html>"}
    sent = next((m for m in WEB_SENT if path == f"wiadomosci/1/6/{m[0]}/f0"), None)
    if sent:
        return {"html": web_message([("Temat", sent[2]), ("Wysłano", sent[4])], sent[3],
                                    '<table class="stretch"><tr><td colspan="3"><b>Przeczytano</b></td></tr>'
                                    f'<tr><td class="left big double">{sent[1]}</td><td class="left">NIE</td></tr></table>')}
    if path == "wiadomosci/1/5/301/f0":
        WEB_READ["301"] = True
        return {"html": web_message(
            [("Nadawca", "Nowak Anna (nauczyciel)"), ("Temat", "Zebranie"), ("Wysłano", "2026-11-09 08:15:00")],
            'Dzień dobry,<br /><br />zebranie we wtorek: <a href="https://example.com/z" target="_blank">https://example.com/z</a>'
            '<script>window.pwned=3</script><img src=x onerror="window.pwned=4">',
            '<table class="stretch"><tr><td class="medium"><b>Przeczytano</b></td><td class="left">2026-11-09 09:00:00</td></tr></table>')}
    if path == "wiadomosci/1/5/300/f0":
        return {"html": web_message(
            [("Nadawca", "Zieliński Piotr"), ("Temat", "Regulamin"), ("Wysłano", "2026-11-02 10:00:00")], "W załączniku.",
            '<table><tr><td colspan="2" class="left"><b>Pliki:</b></td></tr><tr><td><!-- icon --><img src="/assets/img/filetype_icons/pdf.png"/>'
            '<!-- name -->regulamin.pdf</td><td>&nbsp;<!-- download button --><a href="javascript:void(0);">'
            '<img src="/assets/img/homework_files_icons/download.png" class="" onClick=" otworz_w_nowym_oknie( &quot;\\/wiadomosci\\/pobierz_zalacznik\\/300\\/9&quot;, &quot;o2&quot;, 420, 250 ) " />'
            '</a></td></tr></table>')}
    if path == "wiadomosci/1/6/400/f0":
        return {"html": web_message(
            [("Temat", "Pytanie o wycieczkę"), ("Wysłano", "2026-11-03 17:30:00")], "Czy wycieczka jest aktualna?",
            '<table class="stretch"><tr><td colspan="3"><b>Przeczytano</b></td></tr>'
            '<tr><td class="left big double">Nowak Anna (nauczyciel)</td><td class="left">2026-11-03 18:00:00</td></tr></table>')}
    if path == "wiadomosci/pobierz_zalacznik/300/9":
        return {"DownloadUrl": "https://sandbox.librus.pl/GetFile/key"}
    return None

def users_by(ids):
    known = {u["Id"] if isinstance(u["Id"], str) else str(u["Id"]): u for u in S["Users"]["Users"]}
    known["9"] = {"Id": 9, "FirstName": "Jan", "LastName": "Testowy"}
    return {"Users": [known[i] for i in ids.split(",") if i in known]}

def calendar(q):
    y, m = int(q["year"][0]), int(q["month"][0])
    inm = lambda d: dt.date.fromisoformat(d).year == y and dt.date.fromisoformat(d).month == m
    c = {"HomeWorks": [{"Id": i} for i, n in ((5, -1), (1, 2)) if inm(ahead(n))],
         "ClassFreeDays": [{"Id": 2}] if inm(ahead(5)) else [],
         "TeacherFreeDays": [{"Id": 3}] if inm(ahead(2)) else [],
         "SchoolFreeDays": [], "ParentTeacherConferences": [{"Id": 4}] if inm(ahead(20)) else []}
    return {"Calendar": c}

def dynamic(rest, q):
    if rest == "Calendars/7":
        return calendar(q)
    if re.fullmatch(r"HomeWorks/[\d,]+", rest):
        # 1: Matematyka given at lesson 3, Matematyka being lesson 1 that day. 5: a test of a subject not in this plan,
        # another group's in a class split into groups.
        hw = {"1": {"Id": 1, "Date": ahead(2), "Category": {"Id": 1}, "Subject": {"Id": 5},
                    "Content": "Funkcje liniowe", "LessonNo": "3", "CreatedBy": {"Id": 1}},
              "5": {"Id": 5, "Date": ahead(-1), "Category": {"Id": 1}, "Subject": {"Id": 11}, "LessonNo": "1"}}
        found = [hw[i] for i in rest[10:].split(",") if i in hw]
        return {"HomeWork": found[0]} if len(found) == 1 else {"HomeWorks": found}
    if rest == "Calendars/ClassFreeDays/2":
        return {"ClassFreeDays": [{"Id": 2, "DateFrom": ahead(5), "DateTo": ahead(6), "Type": {"Id": 1}, "Name": "Krakow"}]}
    if rest == "Calendars/TeacherFreeDays/3":
        return {"TeacherFreeDay": {"Id": 3, "DateFrom": ahead(2), "DateTo": ahead(2), "Teacher": {"Id": 2}}}
    if rest == "ParentTeacherConferences/4":
        return {"ParentTeacherConferences": [{"Id": 4, "Date": ahead(20), "Name": "Wywiadowka", "Time": "17:00:00", "Teacher": {"Id": 1}}]}
    if rest == "HomeWorkAssignments":
        out = {"HomeWorkAssignments": [
            {"Id": 1, "Topic": "Wypracowanie", "Text": "Opis <b>postaci</b>. https://example.com/a",
             "HomeworkAssigmentFiles": [{"Id": 3, "Name": "karta.pdf"}],
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
    if rest == "Messages/12":
        return {"Message": {"Id": "12", "Subject": json.dumps("Stara"), "SendDate": 1762675200, "Sender": {"Id": "2"},
                            "Receivers": [{"Id": 9}], "AddedFiles": "1", "Body": json.dumps("W załączniku."),
                            "MessageFiles": [{"Id": 5, "Name": "regulamin.pdf"}, {"Id": 6, "Name": ""}]}}
    if rest in ("Messages/Attachment/12-5", "HomeWorkAssignments/Attachment/1-3"):
        return {"DownloadUrl": "https://files.example/" + rest.rsplit("/", 1)[1]}
    if rest == "Messages/Attachment/12-6":
        return {"DownloadUrl": "javascript:alert(1)"}
    if rest == "Realizations":
        return {"Realizations": [{"Id": 100, "Date": ahead(-1), "LessonNo": "2", "Topic": "Lektura", "Lesson": {"Id": "2"}}] + [
            {"Id": i, "Date": ahead(-i), "LessonNo": "1", "Topic": f"Ułamki {i}", "Lesson": {"Id": 1}} for i in range(1, 13)]}
    if rest == "Classes":
        return {"Class": {"Id": 3, "Number": 2, "Symbol": "a", "ClassTutors": [{"Id": 1}], "Unit": {"Id": 4}}}
    if rest == "Units":
        # The class's unit starts every semester with 100 behaviour points; another unit of the school with none.
        return {"Units": [{"Id": 2, "BehaviourGradesSettings": {"StartPoints": {"Semester1": 0}}},
                          {"Id": 4, "BehaviourGradesSettings": {"StartPoints": {"Semester1": 100}}}]}
    if rest == "Schools":
        return {"School": {"Id": 1, "Name": "SP nr 1", "Street": "Szkolna", "BuildingNumber": "5", "Town": "Kraków"}}
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
    def end_headers(self):
        # As main.rs: the page is checked on every load, not taken from the browser's own cache.
        if self.command == "GET" and urlsplit(self.path).path in ("/", "/index.html"): self.send_header("cache-control", "no-cache")
        super().end_headers()
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
                return self.send(401, {"error": "bad_credentials", "detail": "To dane SYNERGIA, nie Konta LIBRUS!"})
            STATE["logged"] = True; return self.send(200, ME)
        if p == "/api/logout":
            STATE["logged"] = False; self.send_response(204); self.end_headers(); return
        STATE["log"][-1] += " " + json.dumps(body, sort_keys=True)
        if p == "/api/push" and STATE["logged"]:
            self.send_response(204); self.end_headers(); return
        if p == "/api/admin/emails" and STATE["logged"]:
            if "@" not in body.get("email", "") or "." not in body["email"].split("@")[1]:
                return self.send(400, {"error": "bad_email"})
            # A new address, as after its first sign-in that Librus refused.
            ACCESS["emails"].insert(0, {"email": body["email"].strip().lower(), "added": 1762675200, "active": False,
                                        "failed": {"reason": "bad_credentials", "said": "To dane SYNERGIA, nie Konta LIBRUS!", "at": 1762678800}})
            return self.send(200, ACCESS)
        rest = p.split("/", 4)[4] if p.startswith("/api/s/") else ""
        if not STATE["logged"] or self.headers.get("content-type") != "application/json":
            return self.send(401, {"error": "unauthorized"})
        if p.startswith("/api/w/2002u/"):
            page = web_post(p.split("/", 4)[4], body)
            return self.send(200, page) if page else self.send(403, {"error": "bad_path"})
        if rest in ("HomeWorkAssignments/MarkAsRead", "HomeWorkAssignments/MarkAsDone"):
            HW["read" if rest.endswith("Read") else "done"].add(body["homework"])
            return self.send(200, {"Status": "OK"})
        if rest == "Messages":
            if body.get("subject") == "blad":
                return self.send(400, {"Status": "Error", "MessagePL": "Odbiorca nie przyjmuje wiadomości."})
            SENT["15"] = body
            return self.send(200, {"Message": {"Id": 15}})
        self.send(404, {"error": "not_found"})
    def do_PUT(self):
        p = urlsplit(self.path).path
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n).decode()
        STATE["log"].append("PUT " + p + " " + raw)
        if p == "/api/push" and STATE["logged"]:
            # The device keeps its quiet hours, as the server does.
            quiet = json.loads(raw or "{}").get("quiet")
            if quiet is not None:
                FEEDS["devices"][0]["quiet"] = quiet
            self.send_response(204); self.end_headers(); return
        self.send(401, {"error": "unauthorized"})
    def do_DELETE(self):
        p = urlsplit(self.path).path
        STATE["log"].append("DELETE " + p)
        if p == "/api/push" and STATE["logged"]:
            n = int(self.headers.get("content-length") or 0)
            STATE["log"][-1] += " " + self.rfile.read(n).decode()
            self.send_response(204); self.end_headers(); return
        if p == "/api/me" and STATE["logged"]:
            STATE["logged"] = False; self.send_response(204); self.end_headers(); return
        if not STATE["logged"] or not p.startswith("/api/admin/emails/"):
            return self.send(401, {"error": "unauthorized"})
        ACCESS["emails"] = [e for e in ACCESS["emails"] if e["email"] != unquote(p.rsplit("/", 1)[1])]
        self.send(200, ACCESS)
    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/__log":
            return self.send(200, STATE["log"])
        if u.path == "/__unread":
            MSG_READ["11"] = False
            return self.send(200, {})
        if u.path in ("/__down", "/__up"):
            STATE["down"] = u.path == "/__down"
            return self.send(200, {})
        if u.path == "/__admin":
            ME["admin"] = False
            return self.send(200, {})
        if u.path == "/__twins":
            ME["accounts"][1]["name"] = ME["accounts"][0]["name"]
            return self.send(200, {})
        if u.path in ("/__slow", "/__fast"):
            STATE["slow"] = u.path == "/__slow"
            return self.send(200, {})
        if u.path in ("/__noavg", "/__avg"):
            STATE["noavg"] = u.path == "/__noavg"
            return self.send(200, {})
        # A link that answers late: the page and the API wait, the hashed files the service worker keeps do not.
        if STATE.get("slow") and not u.path.startswith("/assets/"):
            time.sleep(10)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        STATE["log"].append("GET " + self.path)
        if STATE.get("down") and u.path.startswith("/api/s/"):
            return self.send(502, {"error": "upstream"})
        if u.path == "/api/about":
            return self.send(200, {"operator": "Jan Testowy, jan@example.com", "build": "modified", "commit": "abc"})
        if not STATE["logged"]:
            return self.send(401, {"error": "unauthorized"})
        if u.path == "/api/me":
            return self.send(200, ME)
        if u.path == "/api/admin/emails":
            return self.send(200, ACCESS)
        if u.path == "/api/push":
            return self.send(200, FEEDS)
        if u.path == "/api/activity/1001u":
            now = int(dt.datetime.now().timestamp())
            return self.send(200, {"entries": [
                {"at": now - 600, "kind": "Grades", "change": "Edit", "resource": "2"},
                {"at": now - 2 * 86400, "kind": "Attendances", "change": "Add", "resource": "5"},
                {"at": now - 3 * 86400, "kind": "Grades", "change": "Delete", "resource": "999"},
                {"at": now - 4 * 86400, "kind": "SomethingNew", "change": "Add", "resource": "1"},
                {"at": now - 5 * 86400, "kind": "Timetables", "change": "Edit", "resource": "8"},
                {"at": now - 6 * 86400, "kind": "Messages", "change": "Add", "resource": "11"},
                {"at": now - 7 * 86400, "kind": "Notes", "change": "Add", "resource": "3"}]})
        if u.path.startswith("/api/activity/"):
            return self.send(200, {"entries": []})
        parts = u.path.split("/", 4)
        if len(parts) == 5 and parts[2] == "w":
            page = website(parts[4]) if parts[3] == "2002u" else None
            return self.send(200, page) if page else self.send(400, {"error": "bad_path"})
        if len(parts) == 5 and parts[2] == "s":
            rest = parts[4]
            if parts[3] == "2002u":
                if rest.startswith(("Messages", "HomeWorkAssignments", "Notes")):
                    return self.send(403, {"Status": "Disabled", "MessagePL": "Brak dostępu."})
                if rest in OTHER:
                    return self.send(200, OTHER[rest])
            # A school that hides its averages: zeros for a subject, nothing for the rest.
            if STATE.get("noavg") and rest.endswith("/Averages"):
                return self.send(200, {"Averages": [{"Subject": {"Id": 5}, "Semester1": "0.00", "Semester2": "0.00", "FullYear": "0.00"}]})
            if rest == "Timetables":
                return self.send(200, timetable(parse_qs(u.query)["weekStart"][0]))
            if rest in S:
                return self.send(200, S[rest])
            d = dynamic(rest, parse_qs(u.query))
            if d is not None:
                return self.send(200, d)
            if rest.startswith("BehaviourGrades/Points"):
                return self.send(403, {"error": "http_403"})
            # What Librus answers for a resource the school does not have.
            return self.send(404, {"Status": "Error", "Code": "NotFound", "MessagePL": "Nie znaleziono."})
        self.send(404, {"error": "upstream"})

ThreadingHTTPServer(("127.0.0.1", PORT), partial(H, directory=DIST)).serve_forever()
