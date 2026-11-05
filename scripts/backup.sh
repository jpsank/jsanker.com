#!/usr/bin/env bash
# Back up the production data (databases + OpenChat uploads) to a dated folder on the server,
# keep the last N days, and optionally copy it off the server. Run from cron on the server:
#
#   17 3 * * *  /home/ubuntu/jsanker.com/scripts/backup.sh >> /home/ubuntu/jsanker-backup.log 2>&1
#
# Environment (all optional):
#   BACKUP_DIR        where backups go on the server           (default /srv/jsanker-backups)
#   BACKUP_KEEP_DAYS  delete local backups older than this     (default 14)
#   BACKUP_REMOTE     an rclone destination, e.g. b2:my-bucket/jsanker; if set, each backup is also
#                     copied there (needs rclone installed and configured: `rclone config`)
#
# A backup that only lives on the same server is not enough: pull it to another machine too
# (see docs/DEPLOY-PI.md), e.g.  rsync -az pi@SERVER:/srv/jsanker-backups/ ~/jsanker-backups/
set -euo pipefail
cd "$(dirname "$0")/.."

# honours COMPOSE_FILE / COMPOSE_PROJECT_NAME if set (e.g. for testing); production uses compose.prod.yaml
export COMPOSE_FILE="${COMPOSE_FILE:-compose.prod.yaml}"
COMPOSE="docker compose"
DEST="${BACKUP_DIR:-/srv/jsanker-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
stamp="$(date -u +%Y%m%d-%H%M%S)"
tmp="/tmp/backup-$stamp"

mkdir -p "$DEST"
$COMPOSE exec -T web php bin/backup.php --out="$tmp"
$COMPOSE cp "web:$tmp" "$DEST/$stamp"
$COMPOSE exec -T web rm -rf "$tmp"
chmod -R go-rwx "$DEST/$stamp"
echo "backup written to $DEST/$stamp"

# keep the last KEEP_DAYS days
find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$DEST/$stamp" "$BACKUP_REMOTE/$stamp"
  echo "copied to $BACKUP_REMOTE/$stamp"
fi
