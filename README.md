# Dziennik

PWA do dziennika LIBRUS Synergia dla małej, zamkniętej grupy. Backend w Rust (axum) loguje się do portalu LIBRUS
w imieniu użytkownika, trzyma tokeny zaszyfrowane (AES-256-GCM) w SQLite i pośredniczy w zapytaniach do
`api.librus.pl/3.0`: GET dowolnej ścieżki, POST tylko na listę dozwolonych zapisów (`WRITES` w `src/main.rs`), z treścią
JSON. Na stronie Synergii wysyła wyłącznie formularze z listy `WEB_WRITES`. Hasło nie jest zapisywane.

Projekt nieoficjalny, niezwiązany z firmą Librus: zobacz [Zastrzeżenia](#zastrzeżenia). Po co powstał:
[MANIFEST.md](MANIFEST.md).

Wersja demo: <https://d3andark.github.io/dziennik/>. To ten sam frontend z przykładowymi danymi rodzica dwójki dzieci,
bez logowania i bez serwera: `web/src/demo.js` odpowiada na zapytania aplikacji w przeglądarce, daty idą za zegarem
urządzenia. Build: `cd web && npm run demo` (katalog `web/dist-demo`, ścieżki względne, bez service workera i powiadomień);
`.github/workflows/demo.yml` publikuje go na GitHub Pages przy każdym pushu na `main`.

Widoki: start (wiersz nowych wiadomości i ocen z linkami, plan dnia, ostatnie oceny, 14 dni terminarza, aktywność), aktywność (nowe, zmienione i
usunięte oceny, wpisy frekwencji, uwagi, wiadomości, terminy, zmiany planu), oceny ze średnimi i komentarzami (zwykłe,
punktowe, tekstowe i opisowe: `Grades`, `PointGrades`, `TextGrades`, `DescriptiveGrades`, `DescriptiveTextGrades`,
`DescriptiveGrades/Text`),
plan lekcji na dzień albo tydzień (z opisem zastępstw i przeniesień), frekwencja z procentem i osobnym oznaczeniem nieobecności
nieusprawiedliwionych, usprawiedliwionych, spóźnień i zwolnień (liczniki, przedmioty, filtr wpisów), terminarz,
zadania domowe (najpierw do zrobienia, najbliższy termin na górze; z oznaczeniem "po terminie"), tematy lekcji,
wiadomości, ogłoszenia, uwagi, zachowanie, klasa i nauczyciele (klasa, wychowawca, szkoła).

Zapisy: wysyłanie wiadomości i odpowiedzi (odbiorcy z grup Librusa, bez rodziców), oznaczanie zadań domowych jako
przeczytane (przy otwarciu) i wykonane. Wiadomość oznacza się jako przeczytaną przez jej pobranie;
"Oznacz jako przeczytane" nad listą pobiera nieprzeczytane po 4 naraz. Załączniki wiadomości i zadań
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
terminarz, zmiany w planie. Pomija tematy lekcji i szczęśliwy numerek. Jedno zapytanie na ucznia na rundę, po kolei,
dla osób z włączonym urządzeniem.

Klucz VAPID powstaje przy pierwszym starcie i leży zaszyfrowany w SQLite, bez konfiguracji. Najwyżej 5 urządzeń na
osobę. Wylogowanie wyłącza powiadomienia na tym urządzeniu. Stan kanału każdego ucznia widać na stronie powiadomień.

## Prywatność i szyfrowanie

Tokeny Librusa każdej sesji leżą w SQLite zaszyfrowane (AES-256-GCM) kluczem wyprowadzonym z ciasteczka tej sesji.
Baza trzyma tylko skrót ciasteczka, z którego klucza nie da się odtworzyć, więc ani plik bazy, ani kopia zapasowa, ani
`SECRET_KEY` nie otwierają tokenów bez zalogowanej przeglądarki. Każde urządzenie ma własną kopię.

Wyjątek to powiadomienia: serwer musi czytać Librusa, gdy aplikacja jest zamknięta. Włączenie powiadomień przenosi
tokeny tej sesji do kopii szyfrowanej `SECRET_KEY`, którą serwer otwiera sam; wtedy powstają też urządzenia, stan kanałów
i aktywność. Wyłączenie powiadomień na ostatnim urządzeniu przenosi tokeny z powrotem do sesji i kasuje kopię oraz
aktywność. Inne sesje, które z tej kopii korzystały, logują się ponownie. Po aktualizacji do tej wersji osoby bez
powiadomień logują się raz ponownie, bo ich dotychczasowa kopia jest kasowana.

Czego to nie chroni: hasło przy logowaniu i dane z dziennika przechodzą przez serwer w chwili użycia, a adres e-mail,
lista dostępu i nazwy uczniów w kopii dla powiadomień są czytelne dla serwera. Kto ma władzę nad serwerem, może
podmienić kod i przechwycić dane w locie. Szyfrowanie chroni przed wyciekiem bazy i ciekawskim wglądem w pliki, nie
przed nieuczciwym operatorem.

Aplikacja pokazuje informację z art. 13 RODO przed logowaniem ("Prywatność i RODO") i w "Więcej", "Prywatność", z
danymi operatora ze zmiennej `OPERATOR`. Przycisk "Usuń moje dane" w "Więcej" (`DELETE /api/me`) kasuje wszystko, co
serwer trzyma o tej osobie, na każdym urządzeniu, poza adresem na liście dostępu.

## Zgodność z oficjalnym repozytorium

Przy kompilacji `build.rs` pyta git, czy drzewo jest czyste (bez zmian i nowych plików; każdy śledzony plik ma ten
sam skrót co w commicie) i czy commit leży na gałęzi oficjalnego repozytorium (`github.com/D3anDark/dziennik`,
`src/provenance.rs`). Przy starcie serwer pyta jeszcze GitHub (`api.github.com`, bez danych użytkowników), czy commit
leży na `main`: lokalne gałęzie zdalne da się przestawić dowolnie, a odpowiedzi GitHuba nie. Wynik (`official`,
`modified` albo `unknown`, gdy gita albo GitHuba nie da się zapytać) i commit podaje `GET /api/about` oraz log startu.
Gdy wynik nie jest `official`, ostrzeżenie pokazuje sam serwer, niezależnie od frontendu: do każdej strony HTML,
którą serwuje z `WEB_DIR` (nasz frontend albo dowolny inny), dopisuje skrypt `/api/warning.js`, a ten otwiera okno
modalne: "Hostowana wersja serwera jest niezgodna z tą na oficjalnym repozytorium. Jeżeli nie ufasz osobie hostującej
ten projekt, nie podawaj swojego loginu i hasła." Przy wersji oficjalnej skrypt jest pusty. Serwer nie startuje, gdy
wynik `build.rs` wygląda na podmieniony albo gdy skrypt ostrzeżenia (`src/warning.js`, wkompilowany w serwer) go nie
pokazuje.

To sygnał, nie zabezpieczenie. Kontrole są rozproszone, więc wyciszenie ostrzeżenia wymaga zmian w kilku miejscach
kodu, ale serwer mówi sam o sobie: nieuczciwy operator usunie je wszystkie, a z przeglądarki nie da się sprawdzić,
jaki kod naprawdę działa na serwerze. Nie wykryje też oficjalnego serwera za podstawionym reverse proxy, które widzi
hasła przed serwerem. Okno trafia tylko do stron serwowanych przez ten serwer: frontend postawiony osobno (np. proxy
kieruje `/` gdzie indziej, a do serwera tylko `/api`) go nie dostanie, a frontend może je usunąć własnym skryptem.
Dlatego aplikacja nigdy nie pokazuje plakietki "wersja oficjalna": brak ostrzeżenia niczego nie dowodzi. Mechanizm
łapie uczciwe zmiany, np. fork albo lokalne poprawki. Gałęzie zdalne w `build.rs` są tak świeże jak ostatni `git
fetch`: commit wypchnięty później czyta się jako `modified` do następnego pobrania. GitHub jest pytany raz, przy
starcie: gdy wtedy nie odpowie, wynik zostaje `unknown` do restartu. Obraz Dockera kopiuje całe drzewo z `.git`, więc
instalacja z `install.sh` po `git pull` daje `official`.

## Dostęp

Zalogować się może tylko adres z listy dostępu. Administrator (adres z `ADMIN_EMAILS`) po zalogowaniu widzi w
"Więcej" stronę "Dostęp do aplikacji": dodaje tam i usuwa adresy e-mail kont LIBRUS, bez restartu serwera. Lista
leży w SQLite (tabela `allowed`, najwyżej 500 adresów). Usunięcie adresu od razu wylogowuje tę osobę i kasuje jej
tokeny. Adresy z `ADMIN_EMAILS` i `ALLOWED_EMAILS` mają dostęp zawsze i zmienia się je tylko w konfiguracji.

Sesja trwa 30 dni i odnawia się przy uruchomieniu aplikacji w drugiej połowie tego czasu, więc ponownie loguje się
tylko ten, kto nie otwierał aplikacji przez 30 dni. Tokeny LIBRUS osoby, której wygasły wszystkie sesje i która nie ma
urządzenia z powiadomieniami, są kasowane przy najbliższym logowaniu kogokolwiek. Wygaśnięcie sesji albo cofnięcie
dostępu czyści też dane zapisane w przeglądarce na tryb offline.

## Wygląd

Jeden arkusz `web/src/app.css`: neutralna oprawa bez koloru marki, płaskie powierzchnie z jedną linią, liczby w
cyfrach tabelarycznych. Kolor niosą tylko dane: skala ocen i jeden niebieski (`--mark`) dla tego, co nieprzeczytane,
nowe albo trwa teraz. Na telefonie pasek u góry i zakładki na dole, od 900 px pasek boczny z listą widoków i kont.
Przy pisaniu wiadomości na telefonie zakładek nie ma, żeby pole i przycisk wysyłki miały cały ekran. Ocena z ostatnich
7 dni ma niebieską kropkę, dopóki nie zostanie otwarta na tym urządzeniu (`seen-grades/<login>` w `localStorage`); start
liczy jako nowe tylko takie oceny. Zadania, ogłoszenia i uwagi to wiersze w jednej karcie, jak wiadomości.
Na szerokim ekranie każdy widok zaczyna się przy tej samej krawędzi: listy, wiadomości, formularze i oceny mają
szerokość do czytania (760 px), start i tydzień planu zajmują całą stronę. W tygodniu lekcja o tym samym numerze
stoi w jednym wierszu we wszystkich dniach (subgrid). Notatka nauczyciela do zastępstwa ma kolor tekstu, opis zmiany
jest szary. Ostatnie oceny na starcie są ułożone i datowane po dniu wpisania, ocena semestralna albo roczna ma przy przedmiocie dopisek. W wąskich kolumnach tygodnia znaczniki lekcji (odwołana, zastępstwo, następna) mają własną linię pod przedmiotem, a nagłówek dnia ma tę samą kropkę co pasek dni. W wierszu przedmiotu oceny idą od najstarszej. Usunięty wpis w aktywności ma przekreśloną ikonę swojego widoku. Oceny "zwolniony" i "nieklasyfikowany" mają skrót
"zw" i "nkl" (pełne słowo w `title`). Skala 1-6 idzie od czerwieni przez pomarańcz, bursztyn i limonkę do zieleni;
ocena końcowa jest w pełnym kolorze, spoza skali ma obwódkę. Rok przy dacie pada tylko poza bieżącym rokiem szkolnym.
W planie dzień z odwołaną lekcją ma czerwoną kropkę, dzień z inną zmianą pusty pierścień. Ocena punktowa ma swoje maksimum
("5/20"), żeby nie czytać jej jak oceny ze skali 1-6. Na czerwono jest tylko to, co jest problemem (lekcja odwołana,
zadanie po terminie, nieobecność nieusprawiedliwiona, uwaga negatywna, błąd). Na telefonie godzina końca lekcji stoi
pod godziną początku. Bez sieci pasek mówi, kiedy serwer odpowiedział ostatni raz (zapamiętane w `localStorage`).
Krój Geist jest serwowany z aplikacji (`@fontsource-variable/geist`), bo CSP nie wpuszcza obcych źródeł.

Tydzień w planie i miesiąc w terminarzu zmienia się też przesunięciem palcem (`web/src/swipe.js`): treść idzie za
palcem 1:1, krótki ruch wraca, długi albo szybki przewraca stronę. Przyciski zostają dla myszy i klawiatury.

Plan na starcie i widok planu idą za zegarem urządzenia: po ostatniej dzisiejszej lekcji pokazują następny dzień
z lekcjami (w piątek po południu kolejny tydzień). Widok dnia albo tygodnia zostaje zapamiętany na urządzeniu; bez
wyboru telefon pokazuje dzień, szeroki ekran tydzień. Przycisk "Zainstaluj aplikację" jest w "Więcej" i w pasku
bocznym, gdy przeglądarka pozwala stronie o to zapytać (Chromium); na iOS zamiast niego jest wskazówka.

Widok otwarty ponownie od razu pokazuje ostatnią odpowiedź, a świeżą podmienia, gdy przyjdzie (w pamięci do 40
odpowiedzi, przy zamknięciu aplikacji zapisane w IndexedDB tylko dla tej samej wersji, czyszczone przy wylogowaniu).
Nieudane odświeżenie zostawia dane z dopiskiem; błąd, który może minąć (brak sieci, Librus nie odpowiada), ma przycisk
"Spróbuj ponownie". Powrót wstecz wraca w to samo miejsce strony; po zmianie widoku tytuł karty mówi, gdzie jesteś,
a fokus trafia na nagłówek widoku (czytnik ekranu go odczytuje).

Nowa wersja dociera do zainstalowanej aplikacji sama: przy każdym powrocie do aplikacji (i co godzinę) service worker
sprawdza `sw.js`, który każdy build stempluje innym hashem. Gdy nowa wersja jest już w pamięci, pasek proponuje
"Zaktualizuj", a przy następnym powrocie do aplikacji przeładowuje się ona sama. Pisana wiadomość wstrzymuje oba
aż do wysłania albo porzucenia.
Serwer wysyła `index.html` z `Cache-Control: no-cache`, żeby przeglądarka nie uruchamiała starej wersji z własnej pamięci.

## Uruchomienie

```sh
cd web && npm ci && npm run build && cd ..
SECRET_KEY=$(openssl rand -hex 32) \
ADMIN_EMAILS=ty@example.com \
cargo run --release
```

Zamiast podawać zmienne w wierszu poleceń: `cp .env.example .env`, uzupełnij, potem
`set -a; . ./.env; set +a; cargo run --release`.

`SECRET_KEY` trzymaj stały: zmiana unieważnia kopie tokenów dla powiadomień i klucz VAPID (osoby z powiadomieniami
logują się ponownie i włączają je jeszcze raz). Tokenów w sesjach nie dotyka.

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `ADMIN_EMAILS` | (wymagane to lub `ALLOWED_EMAILS`) | e-maile kont LIBRUS administratorów, po przecinku: mają dostęp i zarządzają listą w aplikacji |
| `ALLOWED_EMAILS` | (puste) | dodatkowe e-maile z dostępem na stałe, po przecinku |
| `SECRET_KEY` | (wymagane) | 64 znaki hex, klucz szyfrowania kopii tokenów dla powiadomień i klucza VAPID |
| `OPERATOR` | (puste) | imię i nazwisko (albo nazwa) oraz kontakt operatora, np. `Jan Kowalski, jan@example.com`: administrator danych w informacji RODO |
| `DB` | `dziennik.db` | plik SQLite |
| `WEB_DIR` | `web/dist` | zbudowany frontend |
| `BIND` | `127.0.0.1:8080` | adres nasłuchu |

Tryb deweloperski frontendu: `cd web && npm run dev` (Vite przekierowuje `/api` na `127.0.0.1:8080`).

## Wdrożenie

Najprościej, na serwerze z Dockerem i domeną, która na niego wskazuje:

```sh
git clone https://github.com/D3anDark/dziennik.git && cd dziennik
sh install.sh
```

Skrypt pyta o domenę i e-mail konta LIBRUS administratora, losuje `SECRET_KEY`, zapisuje `.env` (tylko do odczytu
dla właściciela), buduje obraz (`deploy/Dockerfile`) i uruchamia aplikację za Caddy, który sam zdobywa i odnawia
certyfikat HTTPS (`deploy/compose.yaml`) i wysyła nagłówek HSTS. Potrzebne są wolne porty 80 i 443. Uruchomiony ponownie po `git pull`
aktualizuje aplikację i nie rusza istniejącego `.env`. Baza leży w woluminie Dockera `dziennik_data`: jego i pliku
`.env` dotyczy kopia zapasowa. Bez pytań: `DOMAIN=dziennik.example.pl ADMIN_EMAIL=ty@example.com sh install.sh`.

Bez Dockera: zbuduj jak w "Uruchomienie" i postaw przed aplikacją własne reverse proxy z HTTPS (np. Caddy lub
nginx na `BIND`). Ciasteczko sesji ma `Secure`, więc poza `localhost` HTTPS jest konieczny, wymaga go też service
worker.

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

## Zastrzeżenia

To nie jest opinia prawna.

- **Brak związku z Librus.** Projekt jest nieoficjalny. Nie jest powiązany z Librus sp. z o.o., nie jest przez nią
  tworzony, wspierany, autoryzowany ani sprawdzany. Nazwy LIBRUS i Synergia należą do tej spółki i są tu użyte tylko
  po to, by wskazać, z jakim dziennikiem aplikacja współpracuje.
- **Własny kod.** Aplikacja jest napisana od zera i nie zawiera kodu ani grafik aplikacji Librus. Z serwerami
  Librusa rozmawia wyłącznie po to, by zalogowany użytkownik mógł korzystać z własnego konta.
- **Twoje konto, Twoja odpowiedzialność.** Aplikacja loguje się do konta LIBRUS danymi, które podasz, i działa w
  Twoim imieniu. Regulaminy Librusa dalej Cię obowiązują. Librus może w każdej chwili zmienić albo zablokować dostęp,
  także do konta. Hasło nie jest zapisywane, ale przechodzi przez serwer, na którym stoi aplikacja: korzystaj tylko
  z instancji, której operatorowi ufasz.
- **Operator odpowiada za dane.** Kto uruchamia serwer dla innych osób niż własna rodzina, przetwarza ich dane osobowe
  (adres e-mail, zaszyfrowane tokeny, przy powiadomieniach historia zmian) i jest ich administratorem w rozumieniu RODO.
  Aplikacja daje informację z art. 13 i samodzielne usuwanie danych; resztę robi operator: ustawia `OPERATOR`, zawiera
  umowę powierzenia z firmą hostingową (art. 28), prowadzi rejestr czynności przetwarzania, jeśli go dotyczy (art. 30),
  zgłasza naruszenia do UODO w 72 godziny (art. 33) i odpowiada na pozostałe żądania (dostęp, sprostowanie,
  przeniesienie).
- **Bez obciążania Librusa.** Aplikacja jest przeznaczona dla małej, zamkniętej grupy. Nie używaj jej do masowego
  pobierania danych ani do udostępniania cudzych kont.
- **Bez gwarancji.** Oprogramowanie jest dostarczane "tak jak jest", na warunkach z pliku [LICENSE](LICENSE).

Sprawy prawne, w tym żądanie usunięcia treści: contact@unisic.app.

## Licencja

[MIT](LICENSE): każdy może wziąć ten kod i użyć go, jak chce, także zmienić go i rozpowszechniać dalej. Jedyny
warunek: zostaje nota o autorach i treść licencji. Autorzy: sfrustrowani uczniowie oraz zawiedzeni nauczyciele
i rodzice. Licencja obejmuje kod tego repozytorium, nie nazwy ani dane Librusa.
