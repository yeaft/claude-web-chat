#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${YEAFT_DEV_DEPLOY_CONFIG:-$SCRIPT_DIR/deployer.env}"
readonly HOST_DEPLOY_LOCK_FILE="${HOME:?HOME must be set}/.local/state/yeaft/dev-blue-green.lock"
CRON_MARKER="# yeaft-dev-blue-green-deploy"
CRON_SCHEDULE="${YEAFT_DEV_DEPLOY_SCHEDULE:-* * * * *}"

if [[ ! -r "$CONFIG_FILE" ]]; then
  echo "Missing readable deploy config: $CONFIG_FILE" >&2
  echo "Copy deployer.env.example to deployer.env and set host-specific paths." >&2
  exit 2
fi

for required_command in crontab flock realpath; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 2
  fi
done

if [[ ! -x /usr/bin/logger ]]; then
  echo "Missing executable: /usr/bin/logger" >&2
  exit 2
fi

CONFIG_FILE=$(realpath "$CONFIG_FILE")
set -a
# shellcheck source=/dev/null
source "$CONFIG_FILE"
set +a

LEGACY_DEPLOY_COMMAND="${LEGACY_DEPLOY_COMMAND:-}"
DEPLOY_HANDOFF_TIMEOUT="${DEPLOY_HANDOFF_TIMEOUT:-180}"
DEPLOY_HANDOFF_QUIET_PERIOD="${DEPLOY_HANDOFF_QUIET_PERIOD:-2}"

if [[ ! "$DEPLOY_HANDOFF_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "DEPLOY_HANDOFF_TIMEOUT must be a positive integer" >&2
  exit 2
fi
if [[ ! "$DEPLOY_HANDOFF_QUIET_PERIOD" =~ ^[0-9]+$ ]]; then
  echo "DEPLOY_HANDOFF_QUIET_PERIOD must be a non-negative integer" >&2
  exit 2
fi
validate_cron_path() {
  local value="$1"

  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *%* || "$value" == *\'* ]]; then
    echo "Path contains characters unsupported by crontab: $value" >&2
    return 1
  fi
}

shell_quote() {
  printf "'%s'" "$1"
}

validate_cron_path "$CONFIG_FILE" || exit 2
validate_cron_path "$SCRIPT_DIR/deploy-blue-green.sh" || exit 2

write_crontab() {
  local content="$1"

  if [[ -n "$content" ]]; then
    printf '%s\n' "$content" | crontab -
  else
    printf '' | crontab -
  fi
}

legacy_deploy_running() {
  local cmdline
  local token
  local index
  local -a arguments

  [[ -n "$LEGACY_DEPLOY_COMMAND" ]] || return 1

  for cmdline in /proc/[0-9]*/cmdline; do
    arguments=()
    while IFS= read -r -d '' token; do
      arguments+=("$token")
    done < "$cmdline" 2>/dev/null || true

    for ((index = 0; index + 1 < ${#arguments[@]}; index++)); do
      if [[ "${arguments[$index]}" == "$LEGACY_DEPLOY_COMMAND" && "${arguments[$((index + 1))]}" == dev ]]; then
        return 0
      fi
    done
  done

  return 1
}

wait_for_legacy_quiescence() {
  local deadline=$((SECONDS + DEPLOY_HANDOFF_TIMEOUT))
  local quiet_since=-1

  while (( SECONDS < deadline )); do
    if legacy_deploy_running; then
      quiet_since=-1
    elif (( quiet_since < 0 )); then
      quiet_since=$SECONDS
    elif (( SECONDS - quiet_since >= DEPLOY_HANDOFF_QUIET_PERIOD )); then
      return 0
    fi
    sleep 0.1
  done

  echo "Timed out waiting for the legacy dev deployment to finish" >&2
  return 1
}

mkdir -p "$SCRIPT_DIR/state" "$(dirname "$HOST_DEPLOY_LOCK_FILE")"
chmod 0755 "$SCRIPT_DIR/deploy-blue-green.sh"

# Validate the exact config that the installed cron command will use.
YEAFT_DEV_DEPLOY_CONFIG="$CONFIG_FILE" "$SCRIPT_DIR/deploy-blue-green.sh" --check

# Serialize installers and any already-running new deployer before reading the
# crontab. Legacy transactions do not use this lock and are handled below.
exec 8> "$HOST_DEPLOY_LOCK_FILE"
if ! flock -w "$DEPLOY_HANDOFF_TIMEOUT" 8; then
  echo "Timed out acquiring the host-global dev deployment lock" >&2
  exit 1
fi

original_crontab=$(crontab -l 2>/dev/null || true)
if [[ "$original_crontab" == *"/deploy-blue-green.sh dev"* ]]; then
  if [[ -z "$LEGACY_DEPLOY_COMMAND" ]]; then
    echo "LEGACY_DEPLOY_COMMAND is required while replacing a legacy scheduler" >&2
    exit 2
  fi
  if ! printf '%s\n' "$original_crontab" | awk -v command="$LEGACY_DEPLOY_COMMAND" \
    '{ for (field = 1; field < NF; field++) if ($field == command && $(field + 1) == "dev") found=1 } END { exit found ? 0 : 1 }'
  then
    echo "LEGACY_DEPLOY_COMMAND does not match the scheduler being replaced" >&2
    exit 2
  fi
fi

scheduler_disabled_crontab=$(printf '%s\n' "$original_crontab" | awk -v marker="$CRON_MARKER" \
  'index($0, marker) == 0 && index($0, "/deploy-blue-green.sh dev") == 0')

install_committed=false
restore_original_crontab() {
  local exit_status=$?

  if [[ "$install_committed" != true ]]; then
    write_crontab "$original_crontab" || \
      echo "CRITICAL: failed to restore the original crontab" >&2
  fi
  return "$exit_status"
}
trap restore_original_crontab EXIT

# Stop future launches before waiting for an already-running legacy transaction.
write_crontab "$scheduler_disabled_crontab"
wait_for_legacy_quiescence

# The installer still holds the host-global lock here. A cron tick that lands
# before installer exit will observe it and exit harmlessly.
quoted_config=$(shell_quote "$CONFIG_FILE")
quoted_script=$(shell_quote "$SCRIPT_DIR/deploy-blue-green.sh")
cron_line="$CRON_SCHEDULE YEAFT_DEV_DEPLOY_CONFIG=$quoted_config $quoted_script 2>&1 | /usr/bin/logger -t yeaft-dev-deployer $CRON_MARKER"

if [[ -n "$scheduler_disabled_crontab" ]]; then
  final_crontab="$scheduler_disabled_crontab"$'\n'"$cron_line"
else
  final_crontab="$cron_line"
fi
write_crontab "$final_crontab"

install_committed=true
trap - EXIT
printf 'Installed scheduler: %s\n' "$cron_line"
