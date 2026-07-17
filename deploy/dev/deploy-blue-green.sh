#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${YEAFT_DEV_DEPLOY_CONFIG:-$SCRIPT_DIR/deployer.env}"

if [[ ! -r "$CONFIG_FILE" ]]; then
  echo "Missing readable deploy config: $CONFIG_FILE" >&2
  exit 2
fi

set -a
# shellcheck source=/dev/null
source "$CONFIG_FILE"
set +a

IMAGE="${IMAGE:-ghcr.io/yeaft/yeaft-web-code-agent:dev}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yaml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-yeaft-webchat-dev}"
SERVICE_BLUE="${SERVICE_BLUE:-claude-webchat-dev-blue}"
SERVICE_GREEN="${SERVICE_GREEN:-claude-webchat-dev-green}"
CONTAINER_BLUE="${CONTAINER_BLUE:-claude-webchat-dev-blue}"
CONTAINER_GREEN="${CONTAINER_GREEN:-claude-webchat-dev-green}"
COMPOSE_GREEN_PROFILE="${COMPOSE_GREEN_PROFILE:-green-dev}"
NGINX_CONTAINER="${NGINX_CONTAINER:-nginx_for_servers}"
UPSTREAM_NAME="${UPSTREAM_NAME:-dev_cc_backend}"
HEALTH_PORT="${HEALTH_PORT:-3456}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"
DRAIN_WAIT="${DRAIN_WAIT:-5}"
COMMAND_TIMEOUT="${COMMAND_TIMEOUT:-300}"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-1048576}"
STATE_DIR="${STATE_DIR:-$SCRIPT_DIR/state}"
STATE_FILE="$STATE_DIR/dev.state"
LOG_FILE="$STATE_DIR/dev.log"
LOCK_FILE="$STATE_DIR/dev.lock"
FAILURE_FILE="$STATE_DIR/dev.failure"
SWITCH_FILE="$STATE_DIR/dev.switch"

: "${UPSTREAM_FILE:?UPSTREAM_FILE must be set in $CONFIG_FILE}"
: "${WEBCHAT_ENV_FILE:?WEBCHAT_ENV_FILE must be set in $CONFIG_FILE}"
: "${WEBCHAT_DATA_DIR:?WEBCHAT_DATA_DIR must be set in $CONFIG_FILE}"
: "${DOCKER_NETWORK:?DOCKER_NETWORK must be set in $CONFIG_FILE}"

FORCE_DEPLOY=false
CHECK_ONLY=false
case "${1:-}" in
  "") ;;
  --force) FORCE_DEPLOY=true ;;
  --check) CHECK_ONLY=true ;;
  *)
    echo "Usage: $0 [--force|--check]" >&2
    exit 2
    ;;
esac

mkdir -p "$STATE_DIR"

for required_command in awk docker flock logger mktemp timeout; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 2
  fi
done

if [[ ! -r "$COMPOSE_FILE" ]]; then
  echo "Missing readable Compose file: $COMPOSE_FILE" >&2
  exit 2
fi

# The descriptor lock is atomic. The lock file remains as an inode anchor; the
# kernel releases ownership automatically when this process exits.
exec 9> "$LOCK_FILE"
if ! flock -n 9; then
  if [[ "$CHECK_ONLY" == true ]]; then
    echo "A deployment is already running; configuration was not checked." >&2
    exit 3
  fi
  exit 0
fi

rotate_log() {
  local file="$1"
  local size

  [[ -f "$file" ]] || return 0
  size=$(wc -c < "$file")
  if (( size > LOG_MAX_BYTES )); then
    if ! mv -f "$file" "$file.1"; then
      echo "Failed to rotate log: $file" >&2
      return 1
    fi
  fi
}

log() {
  local message="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  printf '%s\n' "$message"
  printf '%s\n' "$message" >> "$LOG_FILE"
}

log_command_output() {
  local prefix="$1"
  local output="$2"
  local line

  while IFS= read -r line; do
    [[ -n "$line" ]] && log "$prefix$line"
  done <<< "$output"
  return 0
}

record_outcome() {
  local exit_status="$?"
  local failure_count=0
  local temp_file

  set +e
  if (( exit_status == 0 )); then
    rm -f "$FAILURE_FILE"
    return 0
  fi

  if [[ -r "$FAILURE_FILE" ]]; then
    failure_count=$(awk -F= '$1 == "count" { print $2 }' "$FAILURE_FILE")
    [[ "$failure_count" =~ ^[0-9]+$ ]] || failure_count=0
  fi
  failure_count=$(( failure_count + 1 ))

  if temp_file=$(mktemp "$FAILURE_FILE.tmp.XXXXXX"); then
    printf 'count=%s\nlast_failure=%s\nexit_status=%s\n' \
      "$failure_count" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$exit_status" > "$temp_file"
    mv -f "$temp_file" "$FAILURE_FILE"
  fi

  logger -p user.err -t yeaft-dev-deployer \
    "deployment failed (exit=$exit_status, consecutive_failures=$failure_count, details=$LOG_FILE)" 2>/dev/null || true
  return "$exit_status"
}

if [[ "$CHECK_ONLY" == true ]]; then
  [[ -r "$WEBCHAT_ENV_FILE" ]] || { echo "Missing readable webchat env file: $WEBCHAT_ENV_FILE" >&2; exit 2; }
  [[ -d "$WEBCHAT_DATA_DIR" ]] || { echo "Missing webchat data directory: $WEBCHAT_DATA_DIR" >&2; exit 2; }
  [[ -r "$UPSTREAM_FILE" ]] || { echo "Missing readable upstream file: $UPSTREAM_FILE" >&2; exit 2; }
  [[ -w "$(dirname "$UPSTREAM_FILE")" ]] || { echo "Upstream directory is not writable: $(dirname "$UPSTREAM_FILE")" >&2; exit 2; }
  timeout "$COMMAND_TIMEOUT" docker network inspect "$DOCKER_NETWORK" >/dev/null
  timeout "$COMMAND_TIMEOUT" docker inspect "$NGINX_CONTAINER" >/dev/null
  timeout "$COMMAND_TIMEOUT" docker exec "$NGINX_CONTAINER" nginx -t >/dev/null
  timeout "$COMMAND_TIMEOUT" docker compose --project-name "$COMPOSE_PROJECT_NAME" \
    -f "$COMPOSE_FILE" --profile "$COMPOSE_GREEN_PROFILE" config --quiet
  printf 'Yeaft dev deployer configuration is valid.\n'
  exit 0
fi

trap record_outcome EXIT
rotate_log "$LOG_FILE"

get_container_for_side() {
  case "$1" in
    blue) printf '%s\n' "$CONTAINER_BLUE" ;;
    green) printf '%s\n' "$CONTAINER_GREEN" ;;
    *) return 1 ;;
  esac
}

get_service_for_side() {
  case "$1" in
    blue) printf '%s\n' "$SERVICE_BLUE" ;;
    green) printf '%s\n' "$SERVICE_GREEN" ;;
    *) return 1 ;;
  esac
}

read_managed_upstream_side() {
  local side

  [[ -r "$UPSTREAM_FILE" ]] || return 1
  side=$(awk '/^# Active side: (blue|green)$/ { value=$4 } END { print value }' "$UPSTREAM_FILE")
  [[ "$side" == "blue" || "$side" == "green" ]] || return 1
  printf '%s\n' "$side"
}

get_active_side() {
  local side

  # The file nginx consumes is a better recovery source than state if the
  # process died after reload but before the state write.
  if side=$(read_managed_upstream_side); then
    printf '%s\n' "$side"
    return 0
  fi

  if [[ -r "$STATE_FILE" ]]; then
    side=$(cat "$STATE_FILE")
    if [[ "$side" == "blue" || "$side" == "green" ]]; then
      printf '%s\n' "$side"
      return 0
    fi
  fi

  printf '%s\n' blue
}

write_atomic_value() {
  local target_file="$1"
  local value="$2"
  local temp_file

  if ! temp_file=$(mktemp "$target_file.tmp.XXXXXX"); then
    log "Failed to create temp file for $target_file"
    return 1
  fi
  if ! printf '%s\n' "$value" > "$temp_file"; then
    rm -f "$temp_file"
    log "Failed to write temp file for $target_file"
    return 1
  fi
  if ! mv -f "$temp_file" "$target_file"; then
    rm -f "$temp_file"
    log "Failed to replace $target_file"
    return 1
  fi
}

write_state() {
  write_atomic_value "$STATE_FILE" "$1"
}

wait_for_healthy() {
  local container="$1"
  local elapsed=0
  local health

  log "Waiting for $container to become healthy (timeout: ${HEALTH_TIMEOUT}s)..."
  while (( elapsed < HEALTH_TIMEOUT )); do
    health=$(timeout "$COMMAND_TIMEOUT" docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || true)
    if [[ "$health" == "healthy" ]]; then
      log "$container is healthy (${elapsed}s)"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$(( elapsed + HEALTH_INTERVAL ))
  done

  log "$container failed health check after ${HEALTH_TIMEOUT}s"
  return 1
}

render_upstream() {
  local side="$1"
  local destination="$2"
  local container

  if ! container=$(get_container_for_side "$side"); then
    log "Invalid upstream side: $side"
    return 1
  fi

  if ! cat > "$destination" <<EOF
# Blue-green upstream for the Yeaft dev environment
# Managed by deploy-blue-green.sh - DO NOT EDIT MANUALLY
# Active side: $side
upstream $UPSTREAM_NAME {
    server ${container}:${HEALTH_PORT};
}
EOF
  then
    log "Failed to render nginx upstream for $side"
    return 1
  fi
}

replace_upstream_file() {
  local source_file="$1"

  if ! chmod 0644 "$source_file"; then
    log "Failed to set permissions on upstream temp file"
    return 1
  fi
  if ! mv -f "$source_file" "$UPSTREAM_FILE"; then
    log "Failed to atomically replace $UPSTREAM_FILE"
    return 1
  fi
}

reload_nginx() {
  local output

  if ! output=$(timeout "$COMMAND_TIMEOUT" docker exec "$NGINX_CONTAINER" nginx -t 2>&1); then
    log_command_output "nginx: " "$output"
    log "Nginx config validation failed"
    return 1
  fi
  log_command_output "nginx: " "$output"

  if ! output=$(timeout "$COMMAND_TIMEOUT" docker exec "$NGINX_CONTAINER" nginx -s reload 2>&1); then
    log_command_output "nginx: " "$output"
    log "Nginx reload failed"
    return 1
  fi
  log_command_output "nginx: " "$output"
  return 0
}

# Return values:
#   0 - new upstream reloaded successfully
#   1 - switch failed, previous upstream restored and reloaded successfully
#   2 - switch failed and previous upstream could not be verified
switch_upstream() {
  local new_side="$1"
  local previous_side="$2"
  local candidate_file
  local rollback_file

  if ! candidate_file=$(mktemp "${UPSTREAM_FILE}.candidate.XXXXXX"); then
    log "Failed to create candidate upstream file"
    return 1
  fi
  if ! rollback_file=$(mktemp "${UPSTREAM_FILE}.rollback.XXXXXX"); then
    rm -f "$candidate_file"
    log "Failed to create rollback upstream file"
    return 1
  fi

  if ! render_upstream "$new_side" "$candidate_file"; then
    rm -f "$candidate_file" "$rollback_file"
    return 1
  fi

  if [[ -r "$UPSTREAM_FILE" ]]; then
    if ! cp -p "$UPSTREAM_FILE" "$rollback_file"; then
      rm -f "$candidate_file" "$rollback_file"
      log "Failed to preserve previous upstream file"
      return 1
    fi
  elif ! render_upstream "$previous_side" "$rollback_file"; then
    rm -f "$candidate_file" "$rollback_file"
    return 1
  fi

  if ! write_atomic_value "$SWITCH_FILE" "$previous_side"; then
    rm -f "$candidate_file" "$rollback_file"
    return 1
  fi

  log "Switching nginx upstream to $new_side..."
  if ! replace_upstream_file "$candidate_file"; then
    rm -f "$candidate_file" "$rollback_file"
    return 1
  fi

  if reload_nginx; then
    if rm -f "$SWITCH_FILE"; then
      rm -f "$rollback_file"
      log "Nginx reloaded on $new_side"
      return 0
    fi

    log "Failed to commit the upstream transaction; restoring the previous upstream..."
    if ! replace_upstream_file "$rollback_file" || ! reload_nginx; then
      log "CRITICAL: previous upstream could not be restored after transaction commit failure; both app containers will remain running"
      return 2
    fi
    rm -f "$SWITCH_FILE" || true
    log "Previous upstream restored after transaction commit failure"
    return 1
  fi

  log "Upstream switch failed; restoring the previous upstream..."
  if ! replace_upstream_file "$rollback_file"; then
    log "CRITICAL: failed to restore the previous upstream file; both app containers will remain running"
    return 2
  fi
  if ! reload_nginx; then
    log "CRITICAL: previous upstream was restored on disk but nginx reload could not be verified; both app containers will remain running"
    return 2
  fi

  rm -f "$SWITCH_FILE" || true
  log "Previous upstream restored and reloaded successfully"
  return 1
}

recover_incomplete_switch() {
  local previous_side
  local recovery_file

  [[ -e "$SWITCH_FILE" ]] || return 0
  if ! previous_side=$(cat "$SWITCH_FILE"); then
    log "CRITICAL: cannot read incomplete upstream transaction; leaving both app containers running"
    return 1
  fi
  if [[ "$previous_side" != "blue" && "$previous_side" != "green" ]]; then
    log "CRITICAL: invalid incomplete upstream transaction; leaving both app containers running"
    return 1
  fi
  if ! recovery_file=$(mktemp "${UPSTREAM_FILE}.recovery.XXXXXX"); then
    log "CRITICAL: cannot create upstream recovery file; leaving both app containers running"
    return 1
  fi
  if ! render_upstream "$previous_side" "$recovery_file"; then
    rm -f "$recovery_file"
    return 1
  fi

  log "Recovering interrupted upstream switch to $previous_side..."
  if ! replace_upstream_file "$recovery_file" || ! reload_nginx; then
    rm -f "$recovery_file"
    log "CRITICAL: interrupted upstream switch recovery failed; leaving both app containers running"
    return 1
  fi
  if ! rm -f "$SWITCH_FILE"; then
    log "CRITICAL: upstream recovered but transaction marker could not be cleared"
    return 1
  fi
  log "Interrupted upstream switch recovered"
}

cleanup_standby() {
  local container="$1"

  timeout "$COMMAND_TIMEOUT" docker stop "$container" >/dev/null 2>&1 || true
  timeout "$COMMAND_TIMEOUT" docker rm "$container" >/dev/null 2>&1 || true
}

if ! recover_incomplete_switch; then
  exit 1
fi

ACTIVE_SIDE=$(get_active_side)
if [[ "$ACTIVE_SIDE" == "blue" ]]; then
  STANDBY_SIDE=green
else
  STANDBY_SIDE=blue
fi

ACTIVE_CONTAINER=$(get_container_for_side "$ACTIVE_SIDE")
STANDBY_CONTAINER=$(get_container_for_side "$STANDBY_SIDE")
STANDBY_SERVICE=$(get_service_for_side "$STANDBY_SIDE")

CURRENT_IMAGE_ID=$(timeout "$COMMAND_TIMEOUT" docker inspect --format='{{.Image}}' "$ACTIVE_CONTAINER" 2>/dev/null || printf '%s\n' none)
if ! timeout "$COMMAND_TIMEOUT" docker pull "$IMAGE" >/dev/null; then
  log "Failed to pull $IMAGE"
  exit 1
fi
if ! TARGET_IMAGE_ID=$(timeout "$COMMAND_TIMEOUT" docker image inspect --format='{{.Id}}' "$IMAGE" 2>/dev/null); then
  log "Failed to resolve image ID for $IMAGE"
  exit 1
fi

if [[ "$CURRENT_IMAGE_ID" == "$TARGET_IMAGE_ID" && "$FORCE_DEPLOY" == false ]]; then
  exit 0
fi

log "=== Yeaft dev blue-green deploy ==="
log "Active: $ACTIVE_SIDE ($ACTIVE_CONTAINER)"
log "Standby: $STANDBY_SIDE ($STANDBY_CONTAINER)"
if [[ "$FORCE_DEPLOY" == true ]]; then
  log "Forced deploy requested"
else
  log "Active image differs from the resolved dev tag"
fi

compose_args=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE")
if [[ "$STANDBY_SIDE" == "green" ]]; then
  compose_args+=(--profile "$COMPOSE_GREEN_PROFILE")
fi
compose_args+=(up -d "$STANDBY_SERVICE")

set +e
timeout "$COMMAND_TIMEOUT" "${compose_args[@]}"
compose_status=$?
set -e
if (( compose_status != 0 )); then
  log "Failed to start standby service (docker compose exit $compose_status); active side remains $ACTIVE_SIDE"
  cleanup_standby "$STANDBY_CONTAINER"
  exit 1
fi

if ! wait_for_healthy "$STANDBY_CONTAINER"; then
  log "Standby health check failed; active side remains $ACTIVE_SIDE"
  cleanup_standby "$STANDBY_CONTAINER"
  exit 1
fi

set +e
switch_upstream "$STANDBY_SIDE" "$ACTIVE_SIDE"
switch_status=$?
set -e
if (( switch_status != 0 )); then
  if (( switch_status == 1 )); then
    cleanup_standby "$STANDBY_CONTAINER"
    log "Switch rolled back safely; active side remains $ACTIVE_SIDE"
  else
    log "Switch rollback could not be verified; leaving both app containers running"
  fi
  exit 1
fi

# Persist immediately after nginx accepts the new upstream. If this write fails,
# keep both app containers running; the upstream marker recovers truth next time.
if ! write_state "$STANDBY_SIDE"; then
  log "State persistence failed after nginx switch; leaving both app containers running"
  exit 1
fi

log "Draining old side for ${DRAIN_WAIT}s..."
sleep "$DRAIN_WAIT"
if ! timeout "$COMMAND_TIMEOUT" docker stop "$ACTIVE_CONTAINER" >/dev/null; then
  log "Warning: failed to stop old side $ACTIVE_CONTAINER; new side remains active"
fi

log "=== Deploy complete; active side is $STANDBY_SIDE ==="
