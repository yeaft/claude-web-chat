#!/bin/sh

set -eu

runtime_dir=/run/yeaft-turn
status_file=$runtime_dir/healthcheck-status
status_tmp=$status_file.$$
umask 077
awk '/^Uid:|^Gid:|^CapInh:|^CapPrm:|^CapEff:|^CapBnd:|^CapAmb:|^NoNewPrivs:/ {print}' "/proc/$$/status" > "$status_tmp"
mv "$status_tmp" "$status_file"
exec turnutils_stunclient -p "${BROWSER_TURN_LISTEN_PORT:-3478}" 127.0.0.1
