#!/bin/sh
set -eu

source_file="${AGENT_SECRET_FILE:-/run/yeaft-host-secret}"
runtime_dir=/run/yeaft
runtime_file="$runtime_dir/agent-secret"

if [ ! -r "$source_file" ]; then
  echo "Container Agent secret is not readable: $source_file" >&2
  exit 1
fi

install -d -m 0700 -o yeaft -g yeaft "$runtime_dir"
install -m 0600 -o yeaft -g yeaft "$source_file" "$runtime_file"
export AGENT_SECRET_FILE="$runtime_file"

exec /usr/bin/tini -- setpriv --reuid=10001 --regid=10001 --init-groups node agent/cli.js "$@"
