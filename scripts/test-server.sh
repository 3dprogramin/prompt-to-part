#!/usr/bin/env bash
# A test server for this branch: the built app on :8010 (or PORT) with its own data in test-data/,
# so Docker prompt-to-part on :8000 and its data are never touched. `scripts/test-server.sh stop` stops it.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" | grep '^v26' | tail -1)/bin:$PATH"
PID_FILE=test-data/server.pid
mkdir -p test-data
stop() { if [[ -f $PID_FILE ]] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then kill "$(cat $PID_FILE)"; echo "stopped $(cat $PID_FILE)"; fi; rm -f $PID_FILE; }
if [[ ${1:-} == stop ]]; then stop; exit 0; fi
stop
npx vite build > test-data/build.log 2>&1
PORT=${PORT:-8010} PTP_HOST=0.0.0.0 PTP_DATA="$PWD/test-data" nohup node --import tsx server/index.ts --production > test-data/server.log 2>&1 &
echo $! > $PID_FILE
echo "test server pid $(cat $PID_FILE) on :${PORT:-8010} (log: test-data/server.log)"
