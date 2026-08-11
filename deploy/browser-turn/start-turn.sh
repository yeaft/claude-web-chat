#!/bin/sh

set -eu

secret_file=/run/secrets/browser_turn_secret
[ -r "$secret_file" ] || { echo "TURN shared-secret file is not readable" >&2; exit 2; }
secret=$(cat "$secret_file")
case "$secret" in
  ''|*[!A-Za-z0-9_-]*) echo "TURN shared secret must be a non-empty base64url/hex string" >&2; exit 2 ;;
esac
[ "${#secret}" -ge 32 ] || { echo "TURN shared secret must contain at least 32 characters" >&2; exit 2; }

external_ip=${BROWSER_TURN_EXTERNAL_IP:-}
relay_ip=${BROWSER_TURN_RELAY_IP:-}
realm=${BROWSER_TURN_REALM:-}
for address in "$external_ip" "$relay_ip"; do
  case "$address" in
    ''|*[!0-9.]*) echo "TURN external and relay addresses must be IPv4 literals" >&2; exit 2 ;;
  esac
done
case "$realm" in
  ''|*[!A-Za-z0-9._-]*) echo "TURN realm must contain only letters, digits, dot, underscore, or dash" >&2; exit 2 ;;
esac

listen_port=${BROWSER_TURN_LISTEN_PORT:-3478}
min_port=${BROWSER_TURN_MIN_PORT:-49160}
max_port=${BROWSER_TURN_MAX_PORT:-49200}
user_quota=${BROWSER_TURN_USER_QUOTA:-8}
total_quota=${BROWSER_TURN_TOTAL_QUOTA:-128}
max_bps=${BROWSER_TURN_MAX_BPS:-8000000}
bps_capacity=${BROWSER_TURN_BPS_CAPACITY:-64000000}
for number in "$listen_port" "$min_port" "$max_port" "$user_quota" "$total_quota" "$max_bps" "$bps_capacity"; do
  case "$number" in
    ''|*[!0-9]*) echo "TURN ports, quotas, and bandwidth limits must be positive integers" >&2; exit 2 ;;
  esac
done
[ "$listen_port" -ge 1024 ] && [ "$listen_port" -le 65535 ] \
  || { echo "TURN listening port must be between 1024 and 65535" >&2; exit 2; }
[ "$min_port" -ge 1024 ] && [ "$max_port" -le 65535 ] && [ "$min_port" -le "$max_port" ] \
  || { echo "TURN relay port range is invalid" >&2; exit 2; }
[ "$user_quota" -gt 0 ] && [ "$total_quota" -ge "$user_quota" ] \
  || { echo "TURN allocation quotas are invalid" >&2; exit 2; }
[ "$max_bps" -gt 0 ] && [ "$bps_capacity" -ge "$max_bps" ] \
  || { echo "TURN bandwidth limits are invalid" >&2; exit 2; }

runtime_dir=/run/yeaft-turn
config=$runtime_dir/turnserver.conf
binary=$runtime_dir/turnserver
umask 077
cp /usr/bin/turnserver "$binary"
chmod 755 "$binary"
cat > "$config" <<EOF
listening-port=$listen_port
listening-ip=0.0.0.0
relay-ip=$relay_ip
external-ip=$external_ip/$relay_ip
min-port=$min_port
max-port=$max_port
realm=$realm
fingerprint
use-auth-secret
static-auth-secret=$secret
stale-nonce=600
user-quota=$user_quota
total-quota=$total_quota
max-bps=$max_bps
bps-capacity=$bps_capacity
no-multicast-peers
no-tcp-relay
no-tls
no-rfc5780
no-software-attribute
log-file=stdout
simple-log
log-min-level=info
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
EOF

unset secret
chmod 600 "$config"
chown 65534:65534 "$config"
exec setpriv \
  --reuid=65534 --regid=65534 --clear-groups \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
  --no-new-privs \
  "$binary" -c "$config"
