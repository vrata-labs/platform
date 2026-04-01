#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <image-sha-tag>" >&2
  exit 1
fi

IMAGE_TAG="$1"
case "$IMAGE_TAG" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]* ) ;;
  * )
    echo "invalid_image_tag: expected immutable sha-like tag" >&2
    exit 1
    ;;
esac

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/infra/docker/.env.staging"
COMPOSE_FILE="$ROOT_DIR/infra/docker/compose.staging.yml"

log_disk_state() {
  echo "== disk usage =="
  df -h / /var/lib/docker /var/lib/containerd 2>/dev/null || df -h /
  echo "== docker usage =="
  docker system df || true
}

cleanup_docker_state() {
  echo "== docker cleanup =="
  docker container prune -f || true
  docker image prune -af || true
  docker builder prune -af || true
  docker network prune -f || true
}

if [ ! -f "$ENV_FILE" ]; then
  echo "missing_env_file:$ENV_FILE" >&2
  exit 1
fi

python3 - "$ENV_FILE" "$IMAGE_TAG" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
image_tag = sys.argv[2]
lines = env_path.read_text().splitlines()
values = {}
for line in lines:
    if not line or line.lstrip().startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    values[key] = value

values.setdefault('API_IMAGE_REPO', 'cr.yandex/crp9cm29k6p76hqo8lti/noah-api')
values.setdefault('ROOM_STATE_IMAGE_REPO', 'cr.yandex/crp9cm29k6p76hqo8lti/noah-room-state')
values['IMAGE_TAG'] = image_tag

rendered = []
seen = set()
for line in lines:
    if '=' not in line or line.lstrip().startswith('#'):
        rendered.append(line)
        continue
    key, _ = line.split('=', 1)
    if key in values:
      rendered.append(f'{key}={values[key]}')
      seen.add(key)
    else:
      rendered.append(line)

for key in ('API_IMAGE_REPO', 'ROOM_STATE_IMAGE_REPO', 'IMAGE_TAG'):
    if key not in seen:
        rendered.append(f'{key}={values[key]}')

env_path.write_text('\n'.join(rendered) + '\n')
PY

log_disk_state
cleanup_docker_state
log_disk_state

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull api room-state
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --pull never --remove-orphans api room-state caddy
cleanup_docker_state
log_disk_state
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
