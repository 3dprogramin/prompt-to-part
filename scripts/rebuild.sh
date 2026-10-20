#!/usr/bin/env bash
# Rebuilds the Docker Jig once it is idle: waits while a reply is being generated (a Claude Code
# process in the container) or Bambu Studio is slicing, then `docker compose up -d --build` and
# waits for the container to be healthy again.
#   scripts/rebuild.sh          wait for idle (up to 30 min), then rebuild
#   scripts/rebuild.sh --check  only say whether Jig is busy (exit 0 idle, 1 busy)
#   scripts/rebuild.sh --now    rebuild without waiting
set -euo pipefail
cd "$(dirname "$0")/.."
CONTAINER=${JIG_CONTAINER:-jig-jig-1}
WAIT_S=${JIG_REBUILD_WAIT:-1800}

busy() {
  docker top "$CONTAINER" -eo args 2>/dev/null | grep -Eiq 'claude|bambu'
}

case "${1:-}" in
  --check)
    if busy; then echo "Jig is busy (a reply is being generated or a slice is running)"; exit 1; fi
    echo "Jig is idle"; exit 0 ;;
  --now) ;;
  "")
    waited=0
    while busy; do
      if [ "$waited" -ge "$WAIT_S" ]; then echo "Still busy after ${WAIT_S}s – not rebuilding (use --now to force)"; exit 1; fi
      [ "$waited" -eq 0 ] && echo "Jig is busy – waiting for it to finish…"
      sleep 10; waited=$((waited + 10))
    done ;;
  *) echo "usage: $0 [--check | --now]"; exit 2 ;;
esac

docker compose up -d --build
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  if [ "$status" = healthy ]; then echo "Jig is rebuilt and healthy ($(node -p "require('./package.json').version" 2>/dev/null || echo '?'))"; exit 0; fi
  sleep 3
done
echo "The container is not healthy yet ($status): docker logs $CONTAINER"; exit 1
