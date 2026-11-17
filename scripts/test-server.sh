#!/usr/bin/env bash
# A test server for this branch: the built app on :8010 (or PORT) with its own data in test-data/,
# so Docker prompt-to-part on :8000 and its data are never touched. `scripts/test-server.sh stop` stops it.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" | grep '^v26' | tail -1)/bin:$PATH"
PID_FILE=test-data/server.pid
mkdir -p test-data
# The pid file can outlive its server (a reboot, a crash) and the number then belongs to someone else's
# process: only a node running server/index.ts is stopped.
stop() {
  if [[ -f $PID_FILE ]]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null && ps -o args= -p "$pid" 2>/dev/null | grep -q 'server/index.ts'; then kill "$pid"; echo "stopped $pid"; fi
  fi
  rm -f "$PID_FILE"
}
if [[ ${1:-} == stop ]]; then stop; exit 0; fi
stop
npx vite build > test-data/build.log 2>&1
PORT=${PORT:-8010} PTP_HOST=0.0.0.0 PTP_DATA="$PWD/test-data" nohup node --import tsx server/index.ts --production > test-data/server.log 2>&1 &
echo $! > $PID_FILE
echo "test server pid $(cat $PID_FILE) on :${PORT:-8010} (log: test-data/server.log)"
