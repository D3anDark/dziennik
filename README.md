# Dziennik

PWA do dziennika LIBRUS Synergia dla małej, zamkniętej grupy. Backend w Rust (axum) loguje się do portalu LIBRUS
w imieniu użytkownika, trzyma tokeny zaszyfrowane (AES-256-GCM) w SQLite i pośredniczy w zapytaniach do
`api.librus.pl/3.0`: GET dowolnej ścieżki, POST tylko na listę dozwolonych zapisów (`WRITES` w `src/main.rs`), z treścią
JSON. Hasło nie jest zapisywane.

Projekt nieoficjalny, niezwiązany z firmą Librus.

Widoki: start (najbliższe lekcje, ostatnie oceny, 14 dni terminarza), oceny ze średnimi i komentarzami,
plan lekcji, frekwencja z procentem, terminarz, zadania domowe, wiadomości, ogłoszenia, uwagi, zachowanie, nauczyciele.

Zapisy: wysyłanie wiadomości i odpowiedzi (odbiorcy z grup Librusa, bez rodziców), oznaczanie zadań domowych jako
przeczytane (przy otwarciu) i wykonane. Wiadomość oznacza się jako przeczytaną przez jej pobranie;
"Oznacz wszystkie jako przeczytane" pobiera nieprzeczytane po 4 naraz. Załączniki: brak wysyłania i pobierania.

## Uruchomienie

```sh
cd web && npm ci && npm run build && cd ..
SECRET_KEY=$(openssl rand -hex 32) \
ALLOWED_EMAILS=jan@example.com,ala@example.com \
cargo run --release
```

Zamiast podawać zmienne w wierszu poleceń: `cp .env.example .env`, uzupełnij, potem
`set -a; . ./.env; set +a; cargo run --release`.

`SECRET_KEY` trzymaj stały: zmiana unieważnia zapisane tokeny (wszyscy logują się ponownie).

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `ALLOWED_EMAILS` | (wymagane) | e-maile kont LIBRUS z dostępem, po przecinku |
| `SECRET_KEY` | (wymagane) | 64 znaki hex, klucz szyfrowania tokenów |
| `DB` | `dziennik.db` | plik SQLite |
| `WEB_DIR` | `web/dist` | zbudowany frontend |
| `BIND` | `127.0.0.1:8080` | adres nasłuchu |

Tryb deweloperski frontendu: `cd web && npm run dev` (Vite przekierowuje `/api` na `127.0.0.1:8080`).

## Wdrożenie

Ciasteczko sesji ma `Secure`, więc poza `localhost` aplikacja musi stać za HTTPS (np. Caddy lub nginx jako reverse
proxy na `BIND`). Service worker też wymaga HTTPS.

## Testy

`cargo test`: parser strony logowania na wzorze formularza portalu (`tests/login_page.html`) i wyciąganie kodu OAuth.

`cd web && CHROME=/ścieżka/do/chromium npm run e2e`: build i test UI w headless Chromium na fikcyjnym API (`web/e2e/mock.py`): logowanie, wszystkie widoki, wysyłanie i odpowiadanie, oznaczanie przeczytanych i wykonanych, routing, tryb offline,
wylogowanie. `SHOTS=katalog` zachowuje zrzuty ekranu.
