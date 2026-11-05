#!/usr/bin/env bash
# Import the 2019 OpenChat / APedia databases into the LOCAL docker-compose data volume.
#
#   scripts/migrate-legacy.sh /path/to/folder/with/openchat.db,openchat2.db,apedia.db [--dry-run] [--uploads=/path/to/old/attachments]
#
# For a deployed server, run the same thing against its data volume, e.g. on any Docker host:
#   docker run --rm -v <your data volume>:/var/lib/jsanker -v /path/to/legacy-dbs:/legacy:ro <image> \
#       php /app/bin/migrate-legacy.php --legacy-dir=/legacy [--dry-run]
# (or `docker exec`/`fly ssh console` with the legacy files copied somewhere readable).
# Always do a --dry-run first. The legacy files are read as copies and never modified, and
# they must NOT be committed to git (they contain messages and password hashes).
set -euo pipefail
cd "$(dirname "$0")/.."

LEGACY="${1:?usage: scripts/migrate-legacy.sh LEGACY_DIR [--dry-run] [--uploads=DIR]}"
shift
LEGACY="$(cd "$LEGACY" && pwd)"

extra=()
mounts=()
for arg in "$@"; do
  case "$arg" in
    --uploads=*)
      up="$(cd "${arg#--uploads=}" && pwd)"
      mounts+=(-v "$up:/uploads:ro"); extra+=(--uploads=/uploads) ;;
    *) extra+=("$arg") ;;
  esac
done

docker compose build -q web
# the compose data volume is created root-owned; the app runs as "app"
docker compose run --rm --no-deps --user root web chown app /var/lib/jsanker
# (the ${arr[@]+...} form keeps empty arrays working on macOS's bash 3.2 under `set -u`)
docker compose run --rm --no-deps -v "$LEGACY:/legacy:ro" ${mounts[@]+"${mounts[@]}"} web \
  php /app/bin/migrate-legacy.php --legacy-dir=/legacy ${extra[@]+"${extra[@]}"}
