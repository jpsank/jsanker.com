#!/usr/bin/env bash
# Container entrypoint: runs the web server (Caddy + FrankenPHP: the site and the PHP projects) and two Flask apps
# (gunicorn): OpenChat and ProTop's API, side by side.
#
# The web server is what the container is for: if it exits, the container exits and Docker restarts it.
# Each gunicorn is supervised separately: if one crashes it is restarted after a few seconds, and the rest of the
# site keeps serving meanwhile (only /openchat/ or /projects/protop/api/ answers 502 until it is back).
set -u

run_openchat() {
    cd /app/openchat-app || return
    while true; do
        SCRIPT_NAME=/openchat /opt/openchat-venv/bin/gunicorn wsgi:app \
            --bind 127.0.0.1:8000 --workers 1 --threads 4 \
            --timeout 30 --graceful-timeout 10 --max-requests 5000 --max-requests-jitter 500 \
            --no-control-socket --access-logfile - --error-logfile -
        echo "start.sh: gunicorn exited (status $?); restarting in 3s" >&2
        sleep 3
    done
}
run_openchat &
OPENCHAT=$!

run_protop() {
    cd /app/protop-app || return
    while true; do
        SCRIPT_NAME=/projects/protop/api /opt/openchat-venv/bin/gunicorn wsgi:app \
            --bind 127.0.0.1:8001 --workers 1 --threads 4 \
            --timeout 40 --graceful-timeout 10 --max-requests 5000 --max-requests-jitter 500 \
            --no-control-socket --access-logfile - --error-logfile -
        echo "start.sh: protop gunicorn exited (status $?); restarting in 3s" >&2
        sleep 3
    done
}
run_protop &
PROTOP=$!

cd /app
frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile &
WEB=$!

trap 'kill -TERM "$WEB" 2>/dev/null; kill -TERM "$OPENCHAT" 2>/dev/null; kill -TERM "$PROTOP" 2>/dev/null; wait "$WEB"; exit 0' TERM INT

wait "$WEB"
code=$?
echo "start.sh: web server exited (status $code); stopping the container" >&2
kill -TERM "$OPENCHAT" 2>/dev/null
kill -TERM "$PROTOP" 2>/dev/null
exit "$code"
