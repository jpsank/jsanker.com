#!/usr/bin/env bash
# Unit tests + PHP lint, run inside the app image (no local PHP needed).
#   scripts/test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -q -t jsanker-test . >/dev/null
docker run --rm -v "$PWD":/w -w /w jsanker-test sh -c '
  set -e
  echo "== lint"
  find public src bin tests -name "*.php" | while read f; do php -l "$f" >/dev/null; done
  echo "ok"
  echo "== censor"
  php tests/censor_test.php
'
