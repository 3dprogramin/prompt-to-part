#!/usr/bin/env bash
# Rebuilds the Docker prompt-to-part without cutting off a reply: builds the new image first (it keeps
# running), then waits while a reply is being generated (a Claude Code process in the container),
# Bambu Studio is slicing or a picture edit runs (its marker file /tmp/ptp-busy-*), and only then
# swaps the container (`docker compose up -d`, seconds) and waits for it to be healthy again.
#   scripts/rebuild.sh          wait for idle (up to 30 min), then rebuild
#   scripts/rebuild.sh --check  only say whether prompt-to-part is busy (exit 0 idle, 1 busy)
#   scripts/rebuild.sh --now    rebuild without waiting
set -euo pipefail
cd "$(dirname "$0")/.."
CONTAINER=${PTP_CONTAINER:-prompt-to-part-app-1}
WAIT_S=${PTP_REBUILD_WAIT:-1800}

busy() {
  docker top "$CONTAINER" -eo pid,args 2>/dev/null | grep -Eiq 'claude|bambu' ||
    docker exec "$CONTAINER" sh -c 'ls /tmp/ptp-busy-* >/dev/null 2>&1' 2>/dev/null
}

case "${1:-}" in
  --check|--now|"") ;;
  *) echo "usage: $0 [--check | --now]"; exit 2 ;;
esac

if [ "${1:-}" != "--check" ]; then
  echo "Building the new image (prompt-to-part keeps running)…"
  docker compose build
fi

case "${1:-}" in
  --check)
    if busy; then echo "prompt-to-part is busy (a reply is being generated, a slice or a picture edit is running)"; exit 1; fi
    echo "prompt-to-part is idle"; exit 0 ;;
  --now) ;;
  "")
    waited=0
    while busy; do
      if [ "$waited" -ge "$WAIT_S" ]; then echo "Still busy after ${WAIT_S}s – not rebuilding (use --now to force)"; exit 1; fi
      [ "$waited" -eq 0 ] && echo "prompt-to-part is busy, waiting for it to finish…"
      sleep 10; waited=$((waited + 10))
    done ;;
esac

# The swap: the container restarts on the image just built.
docker compose up -d
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  if [ "$status" = healthy ]; then echo "prompt-to-part is rebuilt and healthy ($(node -p "require('./package.json').version" 2>/dev/null || echo '?'))"; exit 0; fi
  sleep 3
done
echo "The container is not healthy yet ($status): docker logs $CONTAINER"; exit 1
