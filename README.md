# Dziennik

PWA do dziennika LIBRUS Synergia dla małej, zamkniętej grupy. Backend w Rust (axum) loguje się do portalu LIBRUS
w imieniu użytkownika, trzyma tokeny zaszyfrowane (AES-256-GCM) w SQLite i pośredniczy w zapytaniach do
`api.librus.pl/3.0`: GET dowolnej ścieżki, POST tylko na listę dozwolonych zapisów (`WRITES` w `src/main.rs`), z treścią
JSON. Hasło nie jest zapisywane.

Projekt nieoficjalny, niezwiązany z firmą Librus: zobacz [Zastrzeżenia](#zastrzeżenia). Po co powstał:
[MANIFEST.md](MANIFEST.md).

Widoki: start (liczniki, plan dnia, aktywność, ostatnie oceny, 14 dni terminarza), aktywność (nowe, zmienione i
usunięte oceny, wpisy frekwencji, uwagi, wiadomości, terminy, zmiany planu), oceny ze średnimi i komentarzami (zwykłe,
punktowe, tekstowe i opisowe: `Grades`, `PointGrades`, `TextGrades`, `DescriptiveGrades`, `DescriptiveTextGrades`,
`DescriptiveGrades/Text`),
plan lekcji (z opisem zastępstw i przeniesień), frekwencja z procentem, terminarz, zadania domowe, tematy lekcji,
wiadomości, ogłoszenia, uwagi, zachowanie, klasa i nauczyciele (klasa, wychowawca, szkoła).

Zapisy: wysyłanie wiadomości i odpowiedzi (odbiorcy z grup Librusa, bez rodziców), oznaczanie zadań domowych jako
przeczytane (przy otwarciu) i wykonane. Wiadomość oznacza się jako przeczytaną przez jej pobranie;
"Oznacz wszystkie jako przeczytane" pobiera nieprzeczytane po 4 naraz. Załączniki wiadomości i zadań
domowych: pobieranie (Librus podaje adres pliku, który otwiera przeglądarka), bez wysyłania.

Wiadomości i zadania domowe Librus udostępnia w API tylko kontom z Mobilnymi Dodatkami: `Messages` odpowiada wtedy
403 `AccessDeny`, a `Me.Account.IsPremium` jest `false`. Dla takich kont wiadomości są czytane ze strony Synergii
(`src/web.rs`, `web/src/webmail.js`): serwer bierze z API jednorazowy `AutoLoginToken`, otwiera nim sesję na
`synergia.librus.pl` i podaje stronę przeglądarce, która ją
parsuje. Działa czytanie obu folderów, pojedynczych wiadomości, załączniki i licznik nieprzeczytanych. Nie działa
pisanie i odpowiadanie oraz dalsze strony folderu (tylko pierwsza). Zadania domowe takiego konta: sam komunikat.

Nieobsługiwane: oceny opisowe z nowego modułu (`Auth/DescriptiveGradingSystem`), usprawiedliwienia, usuwanie
wiadomości, posiłki, przedszkola.

## Powiadomienia

Strona "Powiadomienia" w "Więcej" włącza Web Push na danym urządzeniu (na iPhonie i iPadzie dopiero po dodaniu
aplikacji do ekranu początkowego). Serwer co 10 minut czyta kanał zmian Librusa bez tokenu push
(`ChangeRegister` z `sendPush=0`, potem `PushChanges`). Te same zmiany zapisuje jako
aktywność ucznia (ostatnie 300 wpisów) dla każdego, kto ma ważną sesję albo włączone urządzenie, i wysyła zbiorcze
powiadomienie w rodzaju "Nowe: oceny (2). Zmienione: oceny.":
oceny, zachowanie, nieobecności i spóźnienia (bez zwykłych obecności), uwagi, wiadomości, ogłoszenia, zadania domowe,
terminarz, zmiany w planie. Pomija tematy lekcji i szczęśliwy numerek. Jedno zapytanie na ucznia na rundę, po kolei,
tylko dla osób z włączonym urządzeniem.

Klucz VAPID powstaje przy pierwszym starcie i leży zaszyfrowany w SQLite, bez konfiguracji. Najwyżej 5 urządzeń na
osobę. Wylogowanie wyłącza powiadomienia na tym urządzeniu. Stan kanału każdego ucznia widać na stronie powiadomień.

## Dostęp

Zalogować się może tylko adres z listy dostępu. Administrator (adres z `ADMIN_EMAILS`) po zalogowaniu widzi w
"Więcej" stronę "Dostęp do aplikacji": dodaje tam i usuwa adresy e-mail kont LIBRUS, bez restartu serwera. Lista
leży w SQLite (tabela `allowed`, najwyżej 500 adresów). Usunięcie adresu od razu wylogowuje tę osobę i kasuje jej
tokeny. Adresy z `ADMIN_EMAILS` i `ALLOWED_EMAILS` mają dostęp zawsze i zmienia się je tylko w konfiguracji.

## Wygląd

Jeden arkusz `web/src/app.css`: neutralna oprawa bez koloru marki, płaskie powierzchnie z jedną linią, liczby w
cyfrach tabelarycznych. Kolor niosą tylko dane: skala ocen i jeden niebieski (`--mark`) dla tego, co nieprzeczytane,
nowe albo trwa teraz. Na telefonie pasek u góry i zakładki na dole, od 900 px pasek boczny z listą widoków i kont.
Krój Geist jest serwowany z aplikacji (`@fontsource-variable/geist`), bo CSP nie wpuszcza obcych źródeł.

Tydzień w planie i miesiąc w terminarzu zmienia się też przesunięciem palcem (`web/src/swipe.js`): treść idzie za
palcem 1:1, krótki ruch wraca, długi albo szybki przewraca stronę. Przyciski zostają dla myszy i klawiatury.

Plan na starcie i widok planu idą za zegarem urządzenia: po ostatniej dzisiejszej lekcji pokazują następny dzień
z lekcjami (w piątek po południu kolejny tydzień). Przycisk "Zainstaluj aplikację" jest w "Więcej" i w pasku
bocznym, gdy przeglądarka pozwala stronie o to zapytać (Chromium); na iOS zamiast niego jest wskazówka.

## Uruchomienie

```sh
cd web && npm ci && npm run build && cd ..
SECRET_KEY=$(openssl rand -hex 32) \
ADMIN_EMAILS=ty@example.com \
cargo run --release
```

Zamiast podawać zmienne w wierszu poleceń: `cp .env.example .env`, uzupełnij, potem
`set -a; . ./.env; set +a; cargo run --release`.

`SECRET_KEY` trzymaj stały: zmiana unieważnia zapisane tokeny (wszyscy logują się ponownie).

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `ADMIN_EMAILS` | (wymagane to lub `ALLOWED_EMAILS`) | e-maile kont LIBRUS administratorów, po przecinku: mają dostęp i zarządzają listą w aplikacji |
| `ALLOWED_EMAILS` | (puste) | dodatkowe e-maile z dostępem na stałe, po przecinku |
| `SECRET_KEY` | (wymagane) | 64 znaki hex, klucz szyfrowania tokenów |
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
certyfikat HTTPS (`deploy/compose.yaml`). Potrzebne są wolne porty 80 i 443. Uruchomiony ponownie po `git pull`
aktualizuje aplikację i nie rusza istniejącego `.env`. Baza leży w woluminie Dockera `dziennik_data`: jego i pliku
`.env` dotyczy kopia zapasowa. Bez pytań: `DOMAIN=dziennik.example.pl ADMIN_EMAIL=ty@example.com sh install.sh`.

Bez Dockera: zbuduj jak w "Uruchomienie" i postaw przed aplikacją własne reverse proxy z HTTPS (np. Caddy lub
nginx na `BIND`). Ciasteczko sesji ma `Secure`, więc poza `localhost` HTTPS jest konieczny, wymaga go też service
worker.

## Testy

`cargo test`: parser strony logowania na wzorze formularza portalu (`tests/login_page.html`), wyciąganie kodu OAuth,
lista dostępu (dodanie, limit, usunięcie z wylogowaniem), walidacja adresu e-mail, sesja na stronie Synergii (logowanie
tokenem, ponowne otwarcie po wygaśnięciu, dozwolone ścieżki), szyfrowanie Web Push na przykładzie
z RFC 8291, podpis VAPID oraz cała droga od kanału zmian do odszyfrowanego powiadomienia na atrapie Librusa i usługi push.

`cd web && CHROME=/ścieżka/do/chromium npm run e2e`: build i test UI w headless Chromium na fikcyjnym API (`web/e2e/mock.py`): logowanie, wszystkie widoki, wysyłanie i odpowiadanie, oznaczanie przeczytanych i wykonanych, załączniki, zarządzanie
dostępem, powiadomienia (subskrypcja na atrapie przeglądarki, prawdziwe zdarzenie push w service workerze), systemy
oceniania, wiadomości ze strony Synergii, aktywność, odświeżanie, układ na szerokim ekranie, routing, tryb offline,
wylogowanie. `SHOTS=katalog` zachowuje zrzuty ekranu.

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
- **Operator odpowiada za dane.** Kto uruchamia serwer dla innych osób, przetwarza ich dane osobowe (adres e-mail,
  zaszyfrowane tokeny, historia zmian w ocenach i frekwencji) i sam odpowiada za obowiązki z RODO oraz za zgodę tych
  osób, a przy niepełnoletnich także ich rodziców.
- **Bez obciążania Librusa.** Aplikacja jest przeznaczona dla małej, zamkniętej grupy. Nie używaj jej do masowego
  pobierania danych ani do udostępniania cudzych kont.
- **Bez gwarancji.** Oprogramowanie jest dostarczane "tak jak jest", na warunkach z pliku [LICENSE](LICENSE).

Sprawy prawne, w tym żądanie usunięcia treści: contact@unisic.app.

## Licencja

[MIT](LICENSE): każdy może wziąć ten kod i użyć go, jak chce, także zmienić go i rozpowszechniać dalej. Jedyny
warunek: zostaje nota o autorach i treść licencji. Autorzy: sfrustrowani uczniowie oraz zawiedzeni nauczyciele
i rodzice. Licencja obejmuje kod tego repozytorium, nie nazwy ani dane Librusa.
