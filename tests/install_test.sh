#!/bin/sh
# Runs install.sh against a fake docker: what it writes to .env, what it refuses, and that a second run keeps the key.
set -eu

src=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin" "$tmp/app"
cp "$src/install.sh" "$tmp/app/"
printf '#!/bin/sh\necho "$*" >>"%s/calls"\n' "$tmp" >"$tmp/bin/docker"
chmod +x "$tmp/bin/docker"
PATH="$tmp/bin:$PATH"
cd "$tmp/app"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
has() { grep -Eqx -- "$1" .env || fail ".env has no line matching $1"; }

DOMAIN='evil.pl; rm -rf /' ADMIN_EMAIL=a@b.pl sh install.sh >/dev/null 2>&1 && fail "took a domain with shell characters"
DOMAIN=d.example.pl ADMIN_EMAIL='a@b.pl
SECRET_KEY=0' sh install.sh >/dev/null 2>&1 && fail "took an e-mail with a line break"
DOMAIN=d.example.pl ADMIN_EMAIL=nobody sh install.sh >/dev/null 2>&1 && fail "took an e-mail without a domain"
sh install.sh </dev/null >/dev/null 2>&1 && fail "went on without answers"
[ ! -e .env ] || fail "wrote .env for refused input"

DOMAIN=d.example.pl ADMIN_EMAIL=a@b.pl sh install.sh >/dev/null
has 'DOMAIN=d\.example\.pl'
has 'ADMIN_EMAILS=a@b\.pl'
has 'SECRET_KEY=[0-9a-f]{64}'
[ "$(stat -c %a .env)" = 600 ] || fail ".env is readable by others"
grep -qx -- 'compose --env-file .env -f deploy/compose.yaml up -d --build' "$tmp/calls" || fail "did not start compose"

before=$(cat .env)
DOMAIN=other.example.pl ADMIN_EMAIL=x@y.pl sh install.sh </dev/null >/dev/null
[ "$before" = "$(cat .env)" ] || fail "second run changed .env"

rm .env
printf 'd2.example.pl\nc@d.pl\n' | sh install.sh >/dev/null
has 'DOMAIN=d2\.example\.pl'
has 'ADMIN_EMAILS=c@d\.pl'

printf 'ADMIN_EMAILS=a@b.pl\nSECRET_KEY=kept\n' >.env
DOMAIN=d3.example.pl sh install.sh >/dev/null
has 'DOMAIN=d3\.example\.pl'
has 'SECRET_KEY=kept'

echo "install.sh: ok"
