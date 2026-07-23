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

for required_command in crontab flock mktemp realpath; do
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

read_crontab() {
  local content_variable="$1"
  local exists_variable="$2"
  local error_file
  local output
  local read_status
  local error_output

  error_file=$(mktemp "$SCRIPT_DIR/state/crontab-read.XXXXXX")
  if output=$(LC_ALL=C crontab -l 2>"$error_file"); then
    rm -f "$error_file"
    printf -v "$content_variable" '%s' "$output"
    printf -v "$exists_variable" '%s' true
    return 0
  else
    read_status=$?
  fi

  error_output=$(cat "$error_file")
  rm -f "$error_file"
  if (( read_status == 1 )) && \
    [[ "$error_output" =~ ^no[[:space:]]+crontab[[:space:]]+for[[:space:]].*$ ]]
  then
    printf -v "$content_variable" '%s' ''
    printf -v "$exists_variable" '%s' false
    return 0
  fi

  [[ -n "$error_output" ]] && printf '%s\n' "$error_output" >&2
  echo "Failed to read current crontab (exit $read_status)" >&2
  return "$read_status"
}

write_crontab() {
  local content="$1"

  if [[ -n "$content" ]]; then
    printf '%s\n' "$content" | crontab -
  else
    printf '' | crontab -
  fi
}

restore_crontab() {
  local content="$1"
  local exists="$2"

  if [[ "$exists" == true ]]; then
    write_crontab "$content"
  else
    crontab -r
  fi
}

process_crontab_schedulers() {
  local mode="$1"
  local content="$2"

  printf '%s\n' "$content" | awk \
    -v command="$LEGACY_DEPLOY_COMMAND" \
    -v marker="$CRON_MARKER" \
    -v mode="$mode" '
      function has_exact_legacy(field) {
        if (command == "") return 0
        for (field = 1; field < NF; field++) {
          if ($field == command && $(field + 1) == "dev") return 1
        }
        return 0
      }
      function has_legacy_candidate(field, token) {
        for (field = 1; field < NF; field++) {
          token = $field
          if ($(field + 1) != "dev") continue
          if (token == "deploy-blue-green.sh" || token ~ /\/deploy-blue-green[.]sh$/) return 1
        }
        return 0
      }
      {
        exact_legacy = has_exact_legacy()
        legacy_candidate = has_legacy_candidate()

        if (mode == "has-exact" && exact_legacy) found = 1
        if (mode == "has-candidate" && legacy_candidate) found = 1
        if (mode == "filter" && index($0, marker) == 0 && !exact_legacy) print
      }
      END {
        if (mode == "has-exact" || mode == "has-candidate") exit found ? 0 : 1
      }
    '
}

crontab_has_exact_legacy_scheduler() {
  process_crontab_schedulers has-exact "$1" >/dev/null
}

crontab_has_legacy_scheduler_candidate() {
  process_crontab_schedulers has-candidate "$1" >/dev/null
}

filter_crontab_schedulers() {
  process_crontab_schedulers filter "$1"
}

require_crontab_snapshot() {
  local expected_content="$1"
  local expected_exists="$2"
  local operation="$3"
  local current_content=''
  local current_exists=false

  if ! read_crontab current_content current_exists; then
    echo "Refusing to overwrite crontab while $operation because its current state is unknown" >&2
    return 1
  fi
  if [[ "$current_exists" != "$expected_exists" || "$current_content" != "$expected_content" ]]; then
    echo "Crontab changed concurrently while $operation; refusing to overwrite it" >&2
    return 1
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

original_crontab=''
original_crontab_exists=false
read_crontab original_crontab original_crontab_exists

if crontab_has_legacy_scheduler_candidate "$original_crontab"; then
  if [[ -z "$LEGACY_DEPLOY_COMMAND" ]]; then
    echo "LEGACY_DEPLOY_COMMAND is required while replacing a legacy scheduler" >&2
    exit 2
  fi
  if ! crontab_has_exact_legacy_scheduler "$original_crontab"; then
    echo "LEGACY_DEPLOY_COMMAND does not match the scheduler being replaced" >&2
    exit 2
  fi
fi

scheduler_disabled_crontab=$(filter_crontab_schedulers "$original_crontab")
if crontab_has_legacy_scheduler_candidate "$scheduler_disabled_crontab"; then
  echo "Failed to remove every legacy dev scheduler; refusing to change crontab" >&2
  exit 2
fi

install_committed=false
disabled_snapshot_owned=false
restore_original_crontab() {
  local exit_status=$?

  if [[ "$install_committed" != true && "$disabled_snapshot_owned" == true ]]; then
    if require_crontab_snapshot "$scheduler_disabled_crontab" true \
      'restoring the scheduler after a failed install'
    then
      restore_crontab "$original_crontab" "$original_crontab_exists" || \
        echo "CRITICAL: failed to restore the original crontab" >&2
    else
      echo "CRITICAL: left the concurrently modified crontab untouched" >&2
    fi
  fi
  return "$exit_status"
}
trap restore_original_crontab EXIT

# Stop future launches before waiting for an already-running legacy transaction.
write_crontab "$scheduler_disabled_crontab"
disabled_snapshot_owned=true
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

if ! require_crontab_snapshot "$scheduler_disabled_crontab" true \
  'committing the new scheduler'
then
  # The snapshot no longer belongs to this installer. The EXIT trap must not
  # replace the external writer's crontab with the original stale snapshot.
  disabled_snapshot_owned=false
  exit 1
fi
write_crontab "$final_crontab"

install_committed=true
trap - EXIT
printf 'Installed scheduler: %s\n' "$cron_line"
