#!/usr/bin/env bash
# Build the production image, boot it, and check routes + security headers.
#   scripts/smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8199}
NAME=jsanker-smoke
IMAGE=jsanker-smoke

docker build -q -t "$IMAGE" . >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$NAME" -p "$PORT:80" "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
sleep 3

fail=0
check() { # path expected_status
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$1")
  if [ "$got" = "$2" ]; then echo "ok    $2 $1"; else echo "FAIL  $1 (wanted $2, got $got)"; fail=1; fi
}

for p in / /projects/ /photos/ /blog/ /projects/chemcalc/ /projects/chemcalc/table.php \
         /projects/openchat/ /projects/apedia/ /projects/speedreed/ /projects/wireworld/ \
         /projects/audiovisual/ /projects/hha-grades/ /projects/umusic/ \
         /projects/coronariskmap/ /projects/lucas-gifs/ /projects/riboswitches/ /projects/riboswitches/data.json \
         /projects/yellowstone/ /projects/yellowstone/sim.js /projects/yellowstone/land.js /projects/yellowstone/brain.js \
         /projects/protop/ /projects/protop/search/ /projects/protop/catalog/ /projects/protop/workspace/ /projects/protop/flexibility/ \
         /projects/protop/api/catalog /projects/protop/js/api.js /vendor/ngl/ngl.js /api/pattern.php /assets/site.css \
         /openchat/ /openchat/popular /openchat/chats /openchat/leaderboard /openchat/auth/login \
         /openchat/static/css/style.css; do
  check "$p" 200
done

# Things that must NOT be reachable
for p in /nope /.env /.git/config /src/bootstrap.php /data/chemcalc/elements.json /missing.php \
         /openchat/nope /openchat/secret.key /openchat/app.db /openchat/uploads/..%2fsecret.key /openchat-app/wsgi.py \
         /projects/protop/api/rooms/nope /protop-app/wsgi.py /protop-app/protop/data/catalog.sqlite; do
  check "$p" 404
done

# Security headers on an HTML page
headers=$(curl -sI "http://localhost:$PORT/")
for h in content-security-policy x-content-type-options x-frame-options referrer-policy permissions-policy; do
  if echo "$headers" | grep -qi "^$h:"; then echo "ok    header $h"; else echo "FAIL  header $h missing"; fail=1; fi
done
if echo "$headers" | grep -qi '^server:'; then echo "warn  Server header present"; fi

# OpenChat (Flask, behind Caddy) must carry its own strict CSP and must not need any third party
oc=$(curl -sI "http://localhost:$PORT/openchat/")
if echo "$oc" | grep -qi "^content-security-policy:.*default-src 'none'"; then echo "ok    openchat CSP"; else echo "FAIL  openchat CSP missing"; fail=1; fi
if curl -s "http://localhost:$PORT/openchat/" | grep -qE '(src|href)="https?://'; then echo "FAIL  openchat loads a third-party resource"; fail=1; else echo "ok    openchat is self-contained"; fi

# ProTop's API (second Flask app) carries its own CSP, and a room can be created and read back
pc=$(curl -sI "http://localhost:$PORT/projects/protop/api/catalog")
if echo "$pc" | grep -qi "^content-security-policy:.*default-src 'none'"; then echo "ok    protop api CSP"; else echo "FAIL  protop api CSP missing"; fail=1; fi
room=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"upload":{"name":"t.pdb","text":"ATOM      1  N   ALA A   1      11.104  13.207   2.100  1.00 20.00           N\nEND\n"}}' "http://localhost:$PORT/projects/protop/api/rooms")
rid=$(echo "$room" | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p')
if [ -n "$rid" ]; then check "/projects/protop/api/rooms/$rid" 200; else echo "FAIL  protop room not created: $room"; fail=1; fi

# Runs unprivileged
user=$(docker exec "$NAME" id -un)
if [ "$user" = "app" ]; then echo "ok    runs as app"; else echo "FAIL  runs as $user"; fail=1; fi

exit $fail
