#!/usr/bin/env bash
# Update the production checkout to origin/main and rebuild the web container if anything changed.
# Run by scripts/deploy-listener.py on a GitHub push; also safe to run by hand: scripts/deploy.sh
# Set FORCE=1 to rebuild even when already up to date.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== deploy $(date -Is)"
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ "${FORCE:-0}" != 1 ]; then
    echo "already up to date at $(git rev-parse --short HEAD)"
    exit 0
fi
git merge --ff-only origin/main
echo "now at $(git log --oneline -1)"

# Only `web` is rebuilt; the tunnel keeps running. A failed build leaves the old container serving.
docker compose -f compose.prod.yaml up -d --build web
docker image prune -f >/dev/null
echo "== done"
