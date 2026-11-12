# Dziennik: szczegóły

Pełny opis tego, co [README](../README.md) streszcza: jak aplikacja działa i wygląda, widok po widoku.

## Jak to działa

PWA do dziennika LIBRUS Synergia dla małej, zamkniętej grupy. Backend w Rust (axum) loguje się do portalu LIBRUS
w imieniu użytkownika, trzyma tokeny zaszyfrowane (AES-256-GCM) w SQLite i pośredniczy w zapytaniach do
`api.librus.pl/3.0`: GET dowolnej ścieżki, POST tylko na listę dozwolonych zapisów (`WRITES` w `src/main.rs`), z treścią
JSON. Na stronie Synergii wysyła wyłącznie formularze z listy `WEB_WRITES`. Hasło nie jest zapisywane.

## Demo

Wersja demo: <https://d3andark.github.io/dziennik/>. To ten sam frontend z przykładowymi danymi rodzica trojga dzieci
(trzecie chodzi do szkoły z ocenami punktowymi, procentowymi, literowymi, słownymi i opisowymi, bez średnich z Librusa
i z własnym rodzajem frekwencji), bez logowania i bez serwera: `web/src/demo.js` odpowiada na zapytania aplikacji w
przeglądarce, daty idą za zegarem urządzenia albo za dniem wybranym w banerze demo (styczeń, marzec, czerwiec, lipiec:
oceny i średnie wokół końca semestru i roku). Build: `cd web && npm run demo` (katalog `web/dist-demo`, ścieżki
względne, bez service workera i powiadomień); `.github/workflows/demo.yml` publikuje go na GitHub Pages przy każdym
pushu na `main`.

Link do demo ma własny podgląd (`demoEmbed` w `web/vite.config.js`, tylko w buildzie demo): na Discordzie kartę z
komponentów ([Component Embeds](https://docs.discord.com/developers/link-previews/component-embeds): jeden Container,
do 3000 bajtów, w HTML-u strony) z opisem, dwoma zrzutami ekranu i przyciskami "Otwórz demo" i "Kod i instalacja", a
wszędzie indziej zwykłą kartę z tagów Open Graph. Zrzuty to `web/demo/embed-start.png` i `web/demo/embed-oceny.png`:
odświeża je `SHOTS=katalog e2e/demo.sh` (pliki `demo-desktop-start.png` i `demo-desktop-oceny.png`). Adres strony
demo jest wpisany w `DEMO` w tym pliku: fork z własnym GitHub Pages zmienia go tam. Discord trzyma podgląd około 30
minut; co odczytał, pokazuje jego [Embed Debugger](https://discord.com/developers/embeds).

## Widoki i zapisy

Widoki: start (wiersz nowych wiadomości i ocen z linkami, plan dnia, ostatnie oceny, 14 dni terminarza, aktywność), aktywność (nowe, zmienione i
usunięte oceny, wpisy frekwencji, uwagi, wiadomości, terminy, zmiany planu), oceny ze średnimi i komentarzami (zwykłe,
punktowe, tekstowe i opisowe: `Grades`, `PointGrades`, `TextGrades`, `DescriptiveGrades`, `DescriptiveTextGrades`,
`DescriptiveGrades/Text`),
plan lekcji na dzień albo tydzień (z opisem zastępstw i przeniesień, przerwami i sprawdzianami z terminarza), frekwencja z procentem i osobnym oznaczeniem nieobecności
nieusprawiedliwionych, usprawiedliwionych, spóźnień i zwolnień (liczniki, przedmioty, filtr wpisów), terminarz,
zadania domowe (najpierw do zrobienia, najbliższy termin na górze; z oznaczeniem "po terminie"), tematy lekcji,
wiadomości, ogłoszenia, uwagi, zachowanie, klasa i nauczyciele (klasa, wychowawca, szkoła).

Zapisy: wysyłanie wiadomości i odpowiedzi (odbiorcy z grup Librusa, bez rodziców), oznaczanie zadań domowych jako
przeczytane (przy otwarciu) i wykonane. Wiadomość oznacza się jako przeczytaną przez jej pobranie;
"Oznacz jako przeczytane" nad listą odebranych (widoczne, gdy coś jest nieprzeczytane) pyta o potwierdzenie i pobiera nieprzeczytane po 4 naraz. Załączniki wiadomości i zadań
domowych: pobieranie (Librus podaje adres pliku, który otwiera przeglądarka), bez wysyłania.

Wiadomości i zadania domowe Librus udostępnia w API tylko kontom z Mobilnymi Dodatkami: `Messages` odpowiada wtedy
403 `AccessDeny`, a `Me.Account.IsPremium` jest `false`. Dla takich kont wiadomości są czytane ze strony Synergii
(`src/web.rs`, `web/src/webmail.js`): serwer bierze z API jednorazowy `AutoLoginToken`, otwiera nim sesję na
`synergia.librus.pl` i podaje stronę przeglądarce, która ją
parsuje. Działa czytanie obu folderów, pojedynczych wiadomości, załączniki, licznik nieprzeczytanych oraz pisanie
i odpowiadanie: przeglądarka wypełnia formularz strony (`wiadomosci/2/5` albo `wiadomosci/3/5/<id>`, odbiorcy z
`getRecipients`), a serwer go wysyła. Odpowiedzi strony na formularz aplikacja nie czyta: wiadomość uznaje za wysłaną
dopiero wtedy, gdy pojawi się w folderze "Wysłane", a jeśli się nie pojawi, mówi o tym i niczego nie ponawia.
Ograniczenia: jedna wiadomość trafia do osób z jednej grupy (tak działa formularz strony), bez grupy "Grupa
adresatów", bez załączników, bez cytatu w odpowiedzi; z folderu widać tylko pierwszą stronę. Zadania domowe takiego
konta: sam komunikat.

Nieobsługiwane: oceny opisowe z nowego modułu (`Auth/DescriptiveGradingSystem`), usprawiedliwienia, usuwanie
wiadomości, posiłki, przedszkola.

## Powiadomienia

Strona "Powiadomienia" w "Więcej" włącza Web Push na danym urządzeniu (na iPhonie i iPadzie dopiero po dodaniu
aplikacji do ekranu początkowego). Serwer co 10 minut czyta kanał zmian Librusa bez tokenu push
(`ChangeRegister` z `sendPush=0`, potem `PushChanges`). Te same zmiany zapisuje jako
aktywność ucznia (ostatnie 300 wpisów) dla każdego, kto ma włączone urządzenie, i wysyła zbiorcze
powiadomienie w rodzaju "Nowe: oceny (2). Zmienione: oceny.":
oceny, zachowanie, nieobecności i spóźnienia (bez zwykłych obecności), uwagi, wiadomości, ogłoszenia, zadania domowe,
terminarz, zmiany w planie. Pomija tematy lekcji. Szczęśliwy numerek idzie osobno ("Szczęśliwy numerek na jutro: 13"),
gdy kanał zgłosi jego zmianę. Jedno zapytanie na ucznia na rundę, po kolei, dla osób z włączonym urządzeniem.

Przerwy (`src/breaks.rs`, na nowym urządzeniu wyłączone, włącza się je na stronie powiadomień): na koniec każdej lekcji
powiadomienie "Przerwa 10 min. Następna: Fizyka, sala 26, 08:55."
("Okienko", gdy wypada lekcja). Plan dnia serwer czyta w pierwszej rundzie danego dnia i po zmianie planu w kanale
(`Timetables` i `Classrooms`, dwa zapytania), trzyma go tylko w pamięci, a wysyła o pełnej minucie według czasu
polskiego, z TTL 5 minut i jednym tagiem, więc kolejna przerwa zastępuje poprzednią.

Każde urządzenie wyłącza na stronie powiadomień wybrane rodzaje (oceny, zachowanie, frekwencja, uwagi, wiadomości,
ogłoszenia, zadania, terminarz, plan, numerek, przerwy); wybór leży przy urządzeniu (`devices.off`, `PUT /api/push`).

Cisza nocna (ta sama strona, osobno dla urządzenia): w wybranych godzinach, np. 22:00-07:00, serwer nic na to
urządzenie nie wysyła (`watch::notify`, `devices.quiet`, ten sam `PUT /api/push` z polem `quiet`). Tego, co w tym
czasie przyszło, nie wysyła później: jest w "Aktywności". Godziny są w czasie polskim, jak plan lekcji, także gdy
urządzenie jest w innej strefie.

Klucz VAPID powstaje przy pierwszym starcie i leży zaszyfrowany w SQLite, bez konfiguracji. Najwyżej 5 urządzeń na
osobę. Wylogowanie wyłącza powiadomienia na tym urządzeniu. Stan kanału każdego ucznia widać na stronie powiadomień.

## Zgodność z oficjalnym repozytorium

Przy kompilacji `build.rs` pyta git, czy drzewo jest czyste: bez zmian i nowych plików, każdy śledzony plik ma ten sam
skrót co w commicie. Przy starcie serwer pyta GitHub (`api.github.com`, bez danych użytkowników), czy ten commit leży
na `main` oficjalnego repozytorium (`github.com/D3anDark/dziennik`, `REPO` w `src/main.rs`). Lokalnych gałęzi zdalnych
serwer nie sprawdza: da się je przestawić dowolnie, a platformy budujące mogą klonować bez nich. Wynik
(`official`, `modified` albo `unknown`, gdy gita albo GitHuba nie da się zapytać) i commit podaje `GET /api/about`
oraz log startu. Gdy wynik nie jest `official`, ostrzeżenie pokazuje sam serwer, niezależnie od frontendu: do każdej
strony HTML, którą serwuje z `WEB_DIR` (nasz frontend albo dowolny inny), dopisuje skrypt `/api/warning.js`, a ten
otwiera okno modalne: "Hostowana wersja serwera jest niezgodna z tą na oficjalnym repozytorium. Jeżeli nie ufasz
osobie hostującej ten projekt, nie podawaj swojego loginu i hasła." Przy wersji oficjalnej skrypt jest pusty, tak samo
dla zalogowanej sesji, która login i hasło już podała. Serwer nie startuje, gdy wynik `build.rs` wygląda na
podmieniony albo gdy skrypt ostrzeżenia (`src/warning.js`, wkompilowany w serwer) go nie pokazuje.

To sygnał, nie zabezpieczenie. Kontrole są rozproszone, więc wyciszenie ostrzeżenia wymaga zmian w kilku miejscach
kodu, ale serwer mówi sam o sobie: nieuczciwy operator usunie je wszystkie, a z przeglądarki nie da się sprawdzić,
jaki kod naprawdę działa na serwerze. Nie wykryje też oficjalnego serwera za podstawionym reverse proxy, które widzi
hasła przed serwerem. Okno trafia tylko do stron serwowanych przez ten serwer: frontend postawiony osobno (np. proxy
kieruje `/` gdzie indziej, a do serwera tylko `/api`) go nie dostanie, a frontend może je usunąć własnym skryptem.
Dlatego aplikacja nigdy nie pokazuje plakietki "wersja oficjalna": brak ostrzeżenia niczego nie dowodzi. Mechanizm
łapie uczciwe zmiany, np. fork albo lokalne poprawki. GitHub jest pytany raz, przy starcie: gdy wtedy nie odpowie,
wynik zostaje `unknown` do restartu. Obraz Dockera kopiuje całe drzewo z `.git`, więc instalacja z `install.sh` po
`git pull` daje `official`; nixpacks też kopiuje `.git`, a swój katalog `.nixpacks` dopisuje do kontekstu budowania,
więc jest on w `.gitignore`. Każdy inny plik dopisany przed kompilacją daje `modified`.

## Dostęp

Zalogować się może tylko adres z listy dostępu. Administrator (adres z `ADMIN_EMAILS`) po zalogowaniu widzi w
"Więcej" stronę "Dostęp do aplikacji": dodaje tam i usuwa adresy e-mail kont LIBRUS, bez restartu serwera. Lista
leży w SQLite (tabela `allowed`, najwyżej 500 adresów). Usunięcie adresu od razu wylogowuje tę osobę i kasuje jej
tokeny. Adresy z `ADMIN_EMAILS` i `ALLOWED_EMAILS` mają dostęp zawsze i zmienia się je tylko w konfiguracji.
Gdy Librus odrzuci logowanie, aplikacja pokazuje obok "Nieprawidłowy e-mail lub hasło" to, co napisała strona logowania
Librusa (np. że to dane do Synergii, a nie do Konta LIBRUS). Przy adresie z listy administrator widzi czas i powód
ostatniej nieudanej próby, tak jak zobaczyła go ta osoba, bez hasła; notatka jest tylko w pamięci serwera (najwyżej
jedna na adres) i znika po udanym logowaniu, usunięciu adresu albo restarcie. Log serwera dostaje sam powód
(`login: refused: bad_credentials`), bez adresu. Na dole tej strony stoi commit, z którego zbudowano serwer.

Sesja trwa 30 dni i odnawia się przy uruchomieniu aplikacji w drugiej połowie tego czasu, więc ponownie loguje się
tylko ten, kto nie otwierał aplikacji przez 30 dni. Tokeny LIBRUS osoby, której wygasły wszystkie sesje i która nie ma
urządzenia z powiadomieniami, są kasowane przy najbliższym logowaniu kogokolwiek. Wygaśnięcie sesji albo cofnięcie
dostępu czyści też dane zapisane w przeglądarce na tryb offline.

## Wygląd i zachowanie

Jeden arkusz `web/src/app.css`: neutralna oprawa bez koloru marki, płaskie powierzchnie z jedną linią, liczby w
cyfrach tabelarycznych. Kolor niosą tylko dane: skala ocen i jeden niebieski (`--mark`) dla tego, co nieprzeczytane,
nowe albo trwa teraz. Na telefonie pasek u góry i zakładki na dole, od 900 px pasek boczny z listą widoków i kont.
Przy pisaniu wiadomości na telefonie zakładek nie ma, żeby pole i przycisk wysyłki miały cały ekran. Ocena z ostatnich
7 dni ma niebieską kropkę, dopóki nie zostanie otwarta na tym urządzeniu (`seen-grades/<login>` w `localStorage`); start
liczy jako nowe tylko takie oceny. Zadania, ogłoszenia i uwagi to wiersze w jednej karcie, jak wiadomości.
Na szerokim ekranie każdy widok zaczyna się przy tej samej krawędzi: listy, wiadomości, formularze i oceny mają
szerokość do czytania (760 px), start i tydzień planu zajmują całą stronę. Tydzień to siatka godzin, kolumna na dzień: lekcja zaczyna się na swojej
godzinie i jest tak wysoka, jak długo trwa, więc przerwy i okienka widać jako odstęp; lekcje o tej samej porze (grupy,
odwołana i zastępcza) stoją obok siebie. Blok ma przedmiot ("j. polski" zamiast "Język polski") i salę, od 900 px także godziny i nauczyciela;
czytnik ekranu słyszy całość, a dotknięcie otwiera ten dzień. Trwająca lekcja ma obwódkę i odliczanie, dzisiejszą
kolumnę przecina linia bieżącej godziny z kropką na początku, nad lekcjami; w widoku dnia i na starcie ta sama linia
przecina trwającą lekcję tam, ile jej minęło, a w czasie przerwy jest nią kreska przerwy. Poza godzinami lekcji linii nie ma. Lekcja to blok w odcieniu swojego przedmiotu (odcień z id przedmiotu, poza
czerwienią, która znaczy odwołanie); w widoku dnia między blokami stoi długość przerwy, a przerwa od 15 minut i okienko
są wyróżnione. Sprawdzian albo kartkówka z terminarza stoi na lekcji swojego przedmiotu tego dnia: tej o podanym numerze albo
godzinie, inaczej najbliższej numerem (w klasie łączonej nauczyciel wpisuje jeden termin całej klasie i numer lekcji bywa
cudzy). Wpis z przedmiotu, którego tego dnia nie ma w planie, należy do innej grupy i zostaje tylko w terminarzu. Plan
pobiera do tego terminarz miesięcy, w których leży tydzień. Zastępstwo przekreśla zastąpiony przedmiot i nauczyciela
przed obecnymi (czytnik ekranu słyszy "Biologia, teraz Chemia"). Notatka nauczyciela do zastępstwa ma kolor tekstu, opis
przeniesienia jest szary. Ostatnie oceny na starcie są ułożone i datowane po dniu wpisania, ocena semestralna albo roczna ma przy przedmiocie dopisek. W tygodniu zastępstwo ma kółko przed salą, a sprawdzian etykietę pod przedmiotem; nagłówek dnia ma tę samą kropkę co pasek dni. W wierszu przedmiotu oceny idą od najstarszej. Ocena poprawiona i jej poprawa to jeden kafelek, jak "3*" w aplikacji Librusa: stara ocena stoi przekreślona przed nową (czytnik ekranu słyszy "1, poprawiona na 4"), a szczegóły nowej podają starą z datą i opisem; tak samo na starcie i w aktywności. Parę łączy pole `Improvement` oceny z API, poprawą jest późniejsza z dwóch. Oceny mają przełącznik semestrów: I semestr z oceną semestralną i jej propozycją, II z roczną i średnią roczną, oceny opisowe całego roku w obu; na start II, gdy ma już oceny. Na wąskim ekranie średnie schodzą pod nazwę przedmiotu. Gdy Librus nie podaje żadnej średniej (szkoła je ukrywa), aplikacja liczy je sama w przeglądarce i pisze o tym nad listą: średnia ważona ocen 1-6 z kategorii liczonych do średniej (waga z kategorii, bez wagi 1), plus jako +0,5, minus jako -0,25 (inne wartości do wyboru w "Ustawieniach"), osobno I semestr, II semestr i rok (wszystkie oceny roku); oceny punktowe, słowne, "np", "+" i oceny końcowe się nie liczą, a poprawiona ocena liczy się obok poprawy. Szkoła może liczyć inaczej, więc to przybliżenie. Ukrycie średnich sprawdzane jest osobno dla ocen 1-6 i dla punktowych: średnia, którą Librus podaje dla przedmiotu ocenianego punktami, nie wyłącza liczenia pozostałych. Przedmiot oceniany samymi punktami dostaje od aplikacji procent zdobytych punktów (suma punktów przez sumę maksimów ich kategorii, bez wag, ze znakiem %), gdy Librus nie podaje żadnej średniej punktowej albo przy liczeniu wymuszonym; w średniej ze wszystkich przedmiotów go nie ma, a symulator przy nim się nie pokazuje. Przy ocenach obu rodzajów liczy się skala 1-6. Dla szkoły, która wymaga średniej, a oceny 1-6 wpisuje jako opisowe albo w kategoriach nieliczonych do średniej (Librus nie podaje wtedy żadnej), jest przełącznik "Licz średnie z każdej oceny 1–6" w "Ustawieniach": aplikacja liczy wtedy średnie sama, także gdy Librus je podaje, z każdej oceny, która czyta się jako 1-6, z dowolnego systemu poza punktowym (5 punktów to nie piątka), z wagą kategorii liczonej do średniej, a bez niej raz, a gdy wszystkie wagi w przedmiocie to 0, każda raz (średnia arytmetyczna); przedmiot bez takich ocen zostaje przy średniej z Librusa. Nad listą jest o tym dopisek z linkiem do ustawień. Nad listą stoi też jedna linia o wszystkich przedmiotach: średnia ze średnich pokazanych dla semestru (w II semestrze z rocznych), a gdy są, średnia ocen semestralnych albo rocznych (wcześniej proponowanych); przedmioty punktowe i pojedynczy przedmiot się nie liczą. "Symulator" w pasku ocen dodaje przy przedmiocie oceny na próbę (ocena 1-6 z plusem albo minusem, waga 1-10, najwyżej 20 na przedmiot) i pokazuje średnią semestru, a w II semestrze także roku, przed i po: obie liczy aplikacja tymi samymi regułami, więc "przed" może się różnić od średniej z Librusa. Oceny na próbę nigdzie się nie zapisują i znikają po wyjściu z ocen. Usunięty wpis w aktywności ma przekreśloną ikonę swojego widoku. Oceny "zwolniony" i "nieklasyfikowany" mają skrót
"zw" i "nkl" (pełne słowo w `title`). Skala 1-6 idzie od czerwieni przez pomarańcz, bursztyn i limonkę do zieleni;
ocena końcowa jest w pełnym kolorze, spoza skali ma obwódkę. Rok przy dacie pada tylko poza bieżącym rokiem szkolnym.
W planie dzień z odwołaną lekcją ma czerwoną kropkę, dzień z inną zmianą pusty pierścień. Ocena punktowa ma swoje maksimum
("5/20"), żeby nie czytać jej jak oceny ze skali 1-6. Ocena procentowa ("85%", w dowolnym z systemów ocen) nie jest
oceną 1-6: przedmiot oceniany w procentach ma ich średnią z wagami kategorii. Na czerwono jest tylko to, co jest problemem (lekcja odwołana,
zadanie po terminie, nieobecność nieusprawiedliwiona, uwaga negatywna, błąd). Na telefonie godzina końca lekcji stoi
pod godziną początku. Bez sieci pasek mówi, kiedy serwer odpowiedział ostatni raz (zapamiętane w `localStorage`).
Krój Geist jest serwowany z aplikacji (`@fontsource-variable/geist`), bo CSP nie wpuszcza obcych źródeł.

Tydzień w planie i miesiąc w terminarzu zmienia się też przesunięciem palcem (`web/src/swipe.js`): treść idzie za
palcem 1:1, krótki ruch wraca, długi albo szybki przewraca stronę. Przyciski zostają dla myszy i klawiatury.

Plan na starcie i widok planu idą za zegarem urządzenia: po ostatniej dzisiejszej lekcji pokazują następny dzień
z lekcjami (w piątek po południu kolejny tydzień). Trwająca lekcja ma znacznik "do końca N min", liczony co minutę.
"Ustawienia" (w "Więcej", na szerokim ekranie ikona suwaków w stopce paska bocznego) zbierają to, co zapisane w
`localStorage` urządzenia, nie na serwerze: liczenie średnich z każdej oceny (`forced-averages`), ile w średnich
liczonych przez aplikację dodaje plus (`plus-worth`: +0,5, +0,33, +0,25 albo nic) i odejmuje minus (`minus-worth`:
-0,25, -0,33, -0,5 albo nic), z czego jest średnia roczna (`year-average`: wszystkie oceny roku albo średnia ze
średnich obu semestrów), tryb do zrzutów ekranu i ponowne pokazanie samouczka (kasuje `tour-seen` i ładuje
Start), motyw (`theme`: systemowy, jasny albo ciemny) i widok planu (`plan-view`: automatycznie, dzień albo tydzień;
ten sam klucz zapisuje przełącznik w planie) oraz kolory znaczków frekwencji (`attendance-tone/<rodzaj>`):
nieusprawiedliwione są czerwone, usprawiedliwione zielone, spóźnienia niebieskie, zwolnienia żółte, a każdy rodzaj
można przestawić na jeden z siedmiu odcieni aplikacji (skala ocen i niebieski, z gotowym kontrastem w obu motywach)
albo wrócić do domyślnych; rodzaje wpisów dodane przez szkołę zostają szare. Wybrany motyw nie trzyma drugiej kopii kolorów: `applyTheme` w
`web/src/util.js` zmienia warunek bloku `prefers-color-scheme: dark` w arkuszu na "zawsze" albo "nigdy", a za nim idą
`color-scheme` i kolor paska przeglądarki. Ustawienia ocen są jedne dla wszystkich uczniów konta. Niżej "Aplikacja" (instalacja, samouczek, zgłoszenie
błędu) i "Konto": wylogowanie, które jest też w "Więcej" i w pasku bocznym, oraz "Usuń moje dane" (RODO art. 17),
tylko tutaj, żeby dało się do niego dojść także na szerokim ekranie, który nie ma "Więcej".
Tryb do zrzutów ekranu ("Skróć nazwiska" w "Ustawieniach"): osoby to imię i
pierwsza litera nazwiska ("Anna N."), także uczeń w nagłówku, a adresy e-mail to pierwsza litera i domena
("k…@gmail.com"). Przełącznik zapisuje `short-names` w `localStorage` i ładuje stronę od nowa, więc żaden widok nie
trzyma pełnego nazwiska. Nazwy z pól Librusa (imię i nazwisko osobno) są skracane dokładnie; nazwy ze strony Synergii
("Nowak Anna (nauczyciel)") po pierwszym słowie; etykiety odbiorców wiadomości przez listę osób szkoły, a nieznane do
samych inicjałów. Treść wiadomości, ogłoszeń i komentarzy zostaje bez zmian, tak jak nazwa szkoły.
Widok dnia albo tygodnia zostaje zapamiętany na urządzeniu; bez
wyboru telefon pokazuje dzień, szeroki ekran tydzień. Przycisk "Zainstaluj aplikację" jest w "Więcej" i w pasku
bocznym, gdy przeglądarka pozwala stronie o to zapytać (Chromium); na iOS zamiast niego jest wskazówka. Na Androidzie
"Więcej" i przewodnik radzą instalować z Google Chrome, bo nie wszystkie tamtejsze przeglądarki dobrze obsługują PWA.

Widok otwarty ponownie od razu pokazuje ostatnią odpowiedź, a świeżą podmienia, gdy przyjdzie (w pamięci do 40
odpowiedzi, przy zamknięciu aplikacji zapisane w IndexedDB tylko dla tej samej wersji, czyszczone przy wylogowaniu).
Nieudane odświeżenie zostawia dane z dopiskiem; błąd, który może minąć (brak sieci, Librus nie odpowiada), ma przycisk
"Spróbuj ponownie". Powrót wstecz wraca w to samo miejsce strony; po zmianie widoku tytuł karty mówi, gdzie jesteś,
a fokus trafia na nagłówek widoku (czytnik ekranu go odczytuje).
Na łączu wolniejszym niż 3 s start nie czeka na stronę ani na `/api/me`: service worker daje ich kopię, więc od razu
widać ostatnie dane, a odpowiedź sieci, gdy przyjdzie, zastępuje kopię (`PATIENCE` w `web/public/sw.js`). Pozostałe
zapytania czekają na sieć, żeby stara kopia nie udawała świeżej.

Nowa wersja dociera do zainstalowanej aplikacji sama: przy każdym powrocie do aplikacji (i co godzinę) service worker
sprawdza `sw.js`, który każdy build stempluje innym hashem. Gdy nowa wersja jest już w pamięci, pasek proponuje
"Zaktualizuj", a przy następnym powrocie do aplikacji przeładowuje się ona sama. Pisana wiadomość wstrzymuje oba
aż do wysłania albo porzucenia.
Serwer wysyła `index.html` z `Cache-Control: no-cache`, żeby przeglądarka nie uruchamiała starej wersji z własnej pamięci.

## Testy

`cargo test`: parser strony logowania na wzorze formularza portalu (`tests/login_page.html`), wyciąganie kodu OAuth,
lista dostępu (dodanie, limit, usunięcie z wylogowaniem), odnawianie sesji i kasowanie tokenów bez sesji, walidacja
adresu e-mail, uprawnienia na prawdziwych trasach (brak sesji, lista dostępu tylko dla administratora, zapisy spoza
list, cudzy uczeń, sesja po cofnięciu dostępu), sesja na stronie Synergii (logowanie tokenem, ponowne otwarcie po
wygaśnięciu, dozwolone ścieżki, formularz wysyłany raz i w kodowaniu strony), szyfrowanie Web Push na przykładzie
z RFC 8291, podpis VAPID oraz cała droga od kanału zmian do odszyfrowanego powiadomienia na atrapie Librusa i usługi push.

`cd web && CHROME=/ścieżka/do/chromium npm run e2e`: build i test UI w headless Chromium na fikcyjnym API (`web/e2e/mock.py`): logowanie, wszystkie widoki, wysyłanie i odpowiadanie, oznaczanie przeczytanych i wykonanych, załączniki, zarządzanie
dostępem, powiadomienia (subskrypcja na atrapie przeglądarki, prawdziwe zdarzenie push w service workerze), systemy
oceniania, wiadomości ze strony Synergii (czytanie, nowa wiadomość, odpowiedź, formularz odrzucony przez stronę),
aktywność, ponowna próba przy awarii Librusa, odświeżanie, układ na szerokim ekranie, routing, tryb offline, aktualizacja do nowej wersji, wylogowanie. `SHOTS=katalog` zachowuje zrzuty
ekranu. Ten test działa na atrapie serwera w Pythonie, nie na serwerze Rust.

`cd web && npm run demo && CHROME=/ścieżka/do/chromium e2e/demo.sh`: wersja demo pod podścieżką, jak na GitHub Pages:
każdy widok na telefonie i komputerze bez błędu i z danymi, otwarcie wiadomości, drugie dziecko, plik załącznika.

`.github/workflows/ci.yml` uruchamia `cargo test`, `cargo clippy`, test instalatora i build frontendu. Testu UI w nim
nie ma: wymaga przeglądarki.

`sh tests/install_test.sh`: `install.sh` na atrapie Dockera: co zapisuje do `.env`, co odrzuca (domena i e-mail ze znakami
spoza dozwolonych, brak odpowiedzi) i że ponowne uruchomienie nie zmienia klucza.
