#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${YEAFT_DEV_DEPLOY_CONFIG:-$SCRIPT_DIR/deployer.env}"
CRON_MARKER="# yeaft-dev-blue-green-deploy"
CRON_SCHEDULE="${YEAFT_DEV_DEPLOY_SCHEDULE:-* * * * *}"
CRON_LINE="$CRON_SCHEDULE $SCRIPT_DIR/deploy-blue-green.sh 2>&1 | /usr/bin/logger -t yeaft-dev-deployer $CRON_MARKER"

if [[ ! -r "$CONFIG_FILE" ]]; then
  echo "Missing readable deploy config: $CONFIG_FILE" >&2
  echo "Copy deployer.env.example to deployer.env and set host-specific paths." >&2
  exit 2
fi

if [[ ! -x /usr/bin/logger ]]; then
  echo "Missing executable: /usr/bin/logger" >&2
  exit 2
fi

mkdir -p "$SCRIPT_DIR/state"
chmod 0755 "$SCRIPT_DIR/deploy-blue-green.sh"

YEAFT_DEV_DEPLOY_CONFIG="$CONFIG_FILE" "$SCRIPT_DIR/deploy-blue-green.sh" --check

existing_crontab=$(crontab -l 2>/dev/null || true)
filtered_crontab=$(printf '%s\n' "$existing_crontab" | awk -v marker="$CRON_MARKER" 'index($0, marker) == 0 && index($0, "/deploy-blue-green.sh dev") == 0')
{
  [[ -n "$filtered_crontab" ]] && printf '%s\n' "$filtered_crontab"
  printf '%s\n' "$CRON_LINE"
} | crontab -

printf 'Installed scheduler: %s\n' "$CRON_LINE"
