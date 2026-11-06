#!/usr/bin/env bash
# Put a backup made by scripts/backup.sh back into the production data volume.
#
#   scripts/restore.sh /srv/jsanker-backups/20261104-031700
#
# This REPLACES the live databases (and adds the backed-up uploads). The site is stopped while it
# runs and started again afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="$(cd "${1:?usage: scripts/restore.sh BACKUP_DIR}" && pwd)"
if ! ls "$SRC"/*.sqlite >/dev/null 2>&1; then
  echo "no *.sqlite files in $SRC" >&2
  exit 1
fi

# honours COMPOSE_FILE / COMPOSE_PROJECT_NAME if set (e.g. for testing); production uses compose.prod.yaml
export COMPOSE_FILE="${COMPOSE_FILE:-compose.prod.yaml}"
COMPOSE="docker compose"
echo "About to REPLACE the live data with $SRC:"
cat "$SRC/MANIFEST.txt" 2>/dev/null || ls -la "$SRC"
read -r -p "Type 'restore' to continue: " answer
[ "$answer" = "restore" ] || { echo "aborted"; exit 1; }

$COMPOSE stop web
$COMPOSE run --rm --no-deps --user root -v "$SRC:/restore:ro" web sh -c '
  set -e
  mkdir -p /var/lib/jsanker/db
  for f in /restore/*.sqlite; do
    b="$(basename "$f")"
    rm -f "/var/lib/jsanker/db/$b-wal" "/var/lib/jsanker/db/$b-shm"
    cp "$f" "/var/lib/jsanker/db/$b"
  done
  if [ -d /restore/openchat-uploads ]; then
    mkdir -p /var/lib/jsanker/openchat/uploads
    cp -a /restore/openchat-uploads/. /var/lib/jsanker/openchat/uploads/
  fi
  chown -R app:app /var/lib/jsanker
'
$COMPOSE up -d
echo "restored from $SRC"
