#!/bin/sh
# Stawia Dziennik na serwerze z Dockerem: pyta o domenę i e-mail administratora, zapisuje .env,
# buduje aplikację i uruchamia ją za Caddy z automatycznym HTTPS.
# Uruchomiony ponownie aktualizuje aplikację. Istniejącego .env (a w nim klucza) nie nadpisuje.
set -eu

cd "$(dirname "$0")"
die() {
  printf 'Błąd: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 ||
  die "nie ma Dockera. Zainstaluj go według https://docs.docker.com/engine/install/ i uruchom skrypt ponownie."
docker compose version >/dev/null 2>&1 ||
  die "Docker nie ma polecenia compose. Zainstaluj pakiet docker-compose-plugin."
docker info >/dev/null 2>&1 ||
  die "Docker nie odpowiada albo brakuje uprawnień. Spróbuj: sudo sh install.sh"

ask() {
  # ask ZMIENNA "pytanie": bierze wartość ze środowiska, a gdy jej nie ma, pyta.
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    printf '%s: ' "$2"
    read -r value || die "brak odpowiedzi. Bez pytań: DOMAIN=... ADMIN_EMAIL=... sh install.sh"
  fi
  eval "$1=\$value"
}

if [ ! -f .env ]; then
  ask DOMAIN "Domena, pod którą ma działać dziennik (np. dziennik.example.pl)"
  ask ADMIN_EMAIL "Twój e-mail konta LIBRUS (będziesz administratorem)"
  # Obie wartości trafiają do pliku .env, więc tylko znaki, które nic w nim nie znaczą.
  case $DOMAIN in '' | *[!A-Za-z0-9.-]*) die "domena może mieć tylko litery, cyfry, kropki i myślniki." ;; esac
  case $ADMIN_EMAIL in *[!A-Za-z0-9@._+-]* | *@*@*) die "to nie wygląda na adres e-mail." ;; esac
  case $ADMIN_EMAIL in ?*@?*.?*) ;; *) die "to nie wygląda na adres e-mail." ;; esac
  if command -v openssl >/dev/null 2>&1; then
    key=$(openssl rand -hex 32)
  else
    key=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
  fi
  [ ${#key} -eq 64 ] || die "nie udało się wylosować klucza."
  umask 077
  cat >.env <<ENV
# Utworzone przez install.sh. SECRET_KEY musi zostać ten sam: bez niego zapisane logowania przepadają.
DOMAIN=$DOMAIN
ADMIN_EMAILS=$ADMIN_EMAIL
SECRET_KEY=$key
ENV
  echo "Zapisałem .env."
elif ! grep -q '^DOMAIN=' .env; then
  ask DOMAIN "Domena, pod którą ma działać dziennik (np. dziennik.example.pl)"
  case $DOMAIN in '' | *[!A-Za-z0-9.-]*) die "domena może mieć tylko litery, cyfry, kropki i myślniki." ;; esac
  printf 'DOMAIN=%s\n' "$DOMAIN" >>.env
fi

docker compose --env-file .env -f deploy/compose.yaml up -d --build

domain=$(sed -n 's/^DOMAIN=//p' .env)
cat <<DONE

Gotowe. Dziennik działa pod https://$domain
- Domena musi wskazywać na ten serwer, a porty 80 i 443 być otwarte: wtedy certyfikat HTTPS pojawi się sam.
- Zaloguj się kontem LIBRUS administratora. Kolejne osoby dodasz w aplikacji: Więcej, Dostęp do aplikacji.
- Aktualizacja: git pull, potem ponownie sh install.sh.
- Kopia zapasowa: plik .env oraz wolumin Dockera dziennik_data (baza).
DONE
