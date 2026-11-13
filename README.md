# Dziennik

Nieoficjalna aplikacja do dziennika LIBRUS Synergia dla małej, zamkniętej grupy: działa w przeglądarce i instaluje się
na telefonie (PWA). Własny serwer (Rust) loguje się do Librusa w imieniu użytkownika i pośredniczy w zapytaniach.
Hasła nie zapisuje, tokeny trzyma zaszyfrowane.

- Demo z przykładowymi danymi, bez logowania: <https://unisic.github.io/dziennik/>
- Projekt niezwiązany z firmą Librus: zobacz [Zastrzeżenia](#zastrzeżenia). Po co powstał: [MANIFEST.md](MANIFEST.md).
- Pełny opis, widok po widoku: [docs/szczegoly.md](docs/szczegoly.md).

## Co potrafi

- **Dziennik:** start, aktywność, oceny (zwykłe, punktowe, tekstowe i opisowe), plan na dzień albo tydzień z
  zastępstwami i przerwami, frekwencja, terminarz, zadania domowe, tematy lekcji, wiadomości, ogłoszenia, uwagi,
  zachowanie, klasa i nauczyciele.
- **Oceny:** średnie także wtedy, gdy szkoła ich nie podaje albo wpisuje oceny jako opisowe, przy punktach procent
  zdobytych punktów, przy ocenach procentowych ich średnia, średnia ze wszystkich przedmiotów, symulator "co jeśli
  dostanę 5".
- **Wiadomości:** czytanie, pisanie i odpowiadanie, załączniki do pobrania, "Oznacz jako przeczytane" z potwierdzeniem.
  Konta bez Mobilnych Dodatków czytają i piszą przez stronę Synergii.
- **Powiadomienia** (Web Push): zmiany w dzienniku co 10 minut, szczęśliwy numerek, przerwy. Rodzaje i cisza nocna
  osobno dla każdego urządzenia.
- **Ustawienia** na urządzeniu: język (polski, angielski, ukraiński), motyw, widok planu, kolory frekwencji, sposób liczenia średnich, skracanie nazwisk do
  zrzutów ekranu.
- **Na co dzień:** kilku uczniów na jednym koncie, tryb offline z ostatnimi danymi, instalacja na ekranie telefonu.

Nieobsługiwane: oceny opisowe z nowego modułu, usprawiedliwienia, usuwanie wiadomości, posiłki, przedszkola.

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
git clone https://github.com/unisic/dziennik.git && cd dziennik
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

## Dobrze wiedzieć

- **Kto się zaloguje:** tylko adresy z `ADMIN_EMAILS` i `ALLOWED_EMAILS` oraz te, które admin doda w aplikacji
  ("Dostęp do aplikacji"). Sesja trwa 30 dni i odnawia się przy używaniu.
  [Więcej](docs/szczegoly.md#dostęp)
- **Zmieniony serwer ostrzega:** wersja inna niż z gałęzi `main` oficjalnego repozytorium pokazuje każdemu przed
  logowaniem okno z ostrzeżeniem. Tak ma być: ostrzeżenie dotyczy podania loginu i hasła.
  [Więcej](docs/szczegoly.md#zgodność-z-oficjalnym-repozytorium)
- **Powiadomienia na iPhonie i iPadzie** działają dopiero po dodaniu aplikacji do ekranu początkowego.
  [Więcej](docs/szczegoly.md#powiadomienia)

## Prywatność i szyfrowanie

- **Tokeny Librusa** każdej sesji leżą w SQLite zaszyfrowane (AES-256-GCM) kluczem wyprowadzonym z ciasteczka tej
  sesji. Baza trzyma tylko skrót ciasteczka, z którego klucza nie da się odtworzyć, więc ani plik bazy, ani kopia zapasowa, ani `SECRET_KEY` nie otwierają
  tokenów bez zalogowanej przeglądarki. Każde urządzenie ma własną kopię.
- **Wyjątek to powiadomienia:** serwer musi czytać Librusa, gdy aplikacja jest zamknięta. Włączenie powiadomień
  przenosi tokeny tej sesji do kopii szyfrowanej `SECRET_KEY`, którą serwer otwiera sam; wtedy powstają też urządzenia
  (z wyłączonymi rodzajami i godzinami ciszy), stan kanałów i aktywność. Wyłączenie powiadomień na ostatnim urządzeniu
  przenosi tokeny z powrotem do sesji i kasuje kopię oraz aktywność. Inne sesje, które z tej kopii korzystały, logują
  się ponownie. Po aktualizacji do tej wersji osoby bez powiadomień logują się raz ponownie, bo ich dotychczasowa
  kopia jest kasowana.
- **Czego to nie chroni:** hasło przy logowaniu i dane z dziennika przechodzą przez serwer w chwili użycia. Adres
  e-mail, lista dostępu, nazwy uczniów w kopii dla powiadomień oraz wyłączone rodzaje i godziny ciszy urządzeń są
  czytelne dla serwera, a dzisiejsze lekcje dla powiadomień o przerwach leżą w pamięci procesu do następnego dnia albo
  wyłączenia powiadomień. Kto ma władzę nad serwerem, może podmienić kod i przechwycić dane w locie: szyfrowanie
  chroni przed wyciekiem bazy i ciekawskim wglądem w pliki, nie przed nieuczciwym operatorem.
- **RODO:** informacja z art. 13 jest przed logowaniem ("Prywatność i RODO") i w "Więcej", "Prywatność", z danymi
  operatora ze zmiennej `OPERATOR`. "Usuń moje dane" w "Ustawieniach" (`DELETE /api/me`) kasuje wszystko, co serwer
  trzyma o tej osobie, na każdym urządzeniu, poza adresem na liście dostępu.

## Testy

```sh
cargo test && cargo clippy --all-targets -- -D warnings
cd web && CHROME=/ścieżka/do/chromium npm run e2e
npm run demo && CHROME=/ścieżka/do/chromium e2e/demo.sh
```

Co sprawdzają i czego nie: [docs/szczegoly.md](docs/szczegoly.md#testy).

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
