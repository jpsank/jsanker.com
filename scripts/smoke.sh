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

for p in / /projects/ /photos/ /life/ /blog/ /projects/chemcalc/ /projects/chemcalc/table.php \
         /projects/openchat/ /projects/apedia/ /projects/speedreed/ /projects/wireworld/ \
         /projects/audiovisual/ /projects/hha-grades/ /projects/umusic/ \
         /projects/coronariskmap/ /projects/lucas-gifs/ /api/pattern.php /assets/site.css; do
  check "$p" 200
done

# Things that must NOT be reachable
for p in /nope /.env /.git/config /src/bootstrap.php /data/chemcalc/elements.json /missing.php; do
  check "$p" 404
done

# Security headers on an HTML page
headers=$(curl -sI "http://localhost:$PORT/")
for h in content-security-policy x-content-type-options x-frame-options referrer-policy permissions-policy; do
  if echo "$headers" | grep -qi "^$h:"; then echo "ok    header $h"; else echo "FAIL  header $h missing"; fail=1; fi
done
if echo "$headers" | grep -qi '^server:'; then echo "warn  Server header present"; fi

# Runs unprivileged
user=$(docker exec "$NAME" id -un)
if [ "$user" = "app" ]; then echo "ok    runs as app"; else echo "FAIL  runs as $user"; fail=1; fi

exit $fail
