# Dziennik: zasady dla agentów

PWA do dziennika LIBRUS. Serwer Rust/axum w `src/`, frontend Svelte w `web/src/`. Funkcje i konfiguracja są opisane w
`README.md`; tu są tylko zasady, których nie widać w kodzie.

## Sprawdzanie zmian

- Zawsze: `cargo test` i `cargo clippy --all-targets -- -D warnings` (to samo uruchamia CI).
- Zmiana w `web/`: `cd web && CHROME=/ścieżka/do/chromium npm run e2e`, a dla widoków także
  `npm run demo && CHROME=... e2e/demo.sh`. Nowa trasa API dostaje odpowiedź w `web/e2e/mock.py` i `web/src/demo.js`.

## Zgodność z oficjalnym repozytorium

- Ostrzeżenie należy do backendu, nie do frontendu: frontend może napisać ktoś inny, a ostrzeżenie ma się pojawić i
  tak. `inject` w `src/main.rs` dopisuje do każdej strony HTML z `WEB_DIR` skrypt `/api/warning.js`
  (`src/warning.js`), który przy wersji innej niż oficjalna pokazuje okno modalne. Frontendy nie implementują ostrzeżenia
  same.
- Kontrole wersji zostają nienaruszone. Są celowo rozproszone, żeby wyciszenie ostrzeżenia wymagało zmian w wielu
  miejscach:
  - `build.rs`: czyste drzewo (także pliki nieśledzone i skróty plików zamiast samego indeksu, bez zmiennych `GIT_*`);
    pliki, które platforma budująca dopisuje do kontekstu (np. `.nixpacks`), idą do `.gitignore`;
  - `confirm` w `src/main.rs`: przy starcie pyta GitHub, czy commit leży na `main`, i tylko obniża wynik;
  - start w `main`: odmawia, gdy `BUILD_STATE` i `BUILD_COMMIT` nie wyglądają jak wynik `build.rs` albo gdy skrypt z
    `src/warning.js` nie zawiera tekstu ostrzeżenia (plik jest wkompilowany: usunięty zatrzymuje budowanie);
  - `inject` i `warning_js` w `src/main.rs`: znacznik skryptu trafia do każdej strony przy każdej wersji, a strony
    idą zawsze w całości (bez 304), żeby przeglądarka nie trzymała kopii bez niego.
- Tekst ostrzeżeń jest ustalony przez właściciela projektu (`warning` w `src/main.rs`); zmieniaj go tylko na jego
  prośbę.
- Aplikacja pokazuje wyłącznie ostrzeżenie, gdy wersja nie jest oficjalna. Plakietka "wersja oficjalna" albo
  "zweryfikowano" byłaby fałszywą gwarancją: serwer mówi sam o sobie i zmieniony serwer może kłamać.
- `REPO` w `src/main.rs` zmienia się tylko wtedy, gdy oficjalne repozytorium się przenosi.
- `deploy/Dockerfile` kopiuje do etapu serwera całe drzewo (`COPY . .`), a `.dockerignore` przepuszcza `.git`.
  Bez tego każda instalacja z Dockera czyta się jako `unknown`.
- `/api/warning.js` omija cache w `web/public/sw.js`, żeby ostrzeżenie zawsze pochodziło z bieżącej odpowiedzi.

## Dane osobowe (RODO)

- Tokeny Librusa leżą w kopii sesji, zaszyfrowanej kluczem z jej ciasteczka (`session_cipher` w `src/store.rs`).
  Kopia, którą serwer otwiera sam (`SECRET_KEY`), istnieje tylko u osoby z urządzeniem z powiadomieniami.
- Każde nowe dane osobowe zapisywane na serwerze wymagają w tej samej zmianie: wpisu w informacji z art. 13
  (`web/src/Privacy.svelte`), usuwania przez `Store::forget` i `purge` (klucz obcy do `users` z `ON DELETE CASCADE`),
  limitu rozmiaru w `src/store.rs` oraz opisu w sekcji README "Prywatność i szyfrowanie".
- Logi zawierają tylko informacje techniczne: kody odpowiedzi, etapy, błędy bazy. Adresy e-mail, tokeny, hasła i
  treści z dziennika zostają poza logami.

## VULCAN

- Integracja z VULCAN czeka na pisemną zgodę firmy VULCAN. Regulamin eduVULCAN (rozdz. II ust. 15) pozwala na dostęp
  do konta tylko przez przeglądarkę, a powiadomienia i wiadomości to tam płatna usługa. `src/vulcan.rs` zostaje
  niepodpięty: `// mod vulcan;` w `main.rs` zostaje zakomentowane, a jego wymagania (`httpdate` w `Cargo.toml`)
  opisuje komentarz przy nim.
