#!/usr/bin/env bash
# One-time setup on the Pi: run the deploy listener as a systemd service.   sudo scripts/install-deploy-hook.sh
# Creates ~/.deploy-secret (the shared secret you paste into the GitHub webhook) if it does not exist.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
USER_NAME="${SUDO_USER:?run via sudo from your normal account}"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SECRET_FILE="$HOME_DIR/.deploy-secret"

if [ ! -s "$SECRET_FILE" ]; then
    umask 077
    openssl rand -hex 32 > "$SECRET_FILE"
    chown "$USER_NAME":"$USER_NAME" "$SECRET_FILE"
    echo "Created $SECRET_FILE"
fi

cat > /etc/systemd/system/jsanker-deploy.service <<UNIT
[Unit]
Description=jsanker.com deploy webhook listener
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
User=$USER_NAME
WorkingDirectory=$REPO_DIR
Environment=SECRET_FILE=$SECRET_FILE
ExecStart=/usr/bin/python3 $REPO_DIR/scripts/deploy-listener.py
Restart=always
RestartSec=5
MemoryMax=64M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now jsanker-deploy.service
sleep 1
systemctl --no-pager --lines=5 status jsanker-deploy.service || true
echo
echo "Webhook secret (paste into GitHub -> Settings -> Webhooks -> Secret):"
cat "$SECRET_FILE"
