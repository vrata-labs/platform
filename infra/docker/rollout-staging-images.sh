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

cleanup_transient_docker_state() {
  echo "== docker transient cleanup =="
  docker container prune -f || true
  docker image prune -f || true
  docker builder prune -af || true
  docker network prune -f || true
}

pull_compose_service() {
  local service="$1"
  local output
  if ! output="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull "$service" 2>&1)"; then
    printf '%s\n' "$output" >&2
    case "$output" in
      *"no space left on device"* )
        echo "pull_no_space_retry:$service" >&2
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop "$service" || true
        cleanup_docker_state
        log_disk_state
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull "$service"
        ;;
      * )
        return 1
        ;;
    esac
  else
    printf '%s\n' "$output"
  fi
  cleanup_transient_docker_state
  log_disk_state
}

rollout_compose_service() {
  local service="$1"
  pull_compose_service "$service"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --pull never --no-deps "$service"
  cleanup_docker_state
  log_disk_state
}

env_value() {
  local key="$1"
  python3 - "$ENV_FILE" "$key" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
target = sys.argv[2]
for line in env_path.read_text().splitlines():
    if not line or line.lstrip().startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    if key == target:
        print(value)
        break
PY
}

url_join() {
  python3 - "$1" "$2" <<'PY'
from urllib.parse import urljoin
import sys

print(urljoin(sys.argv[1], sys.argv[2]))
PY
}

wait_for_api() {
  local api_base="$1"
  for _ in $(seq 1 30); do
    if curl -fsS "$api_base/health" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  curl -fsS "$api_base/health" >/dev/null
}

preflight_scene_url() {
  local scene_url="$1"
  local manifest
  local manifest_file
  local glb_path
  local glb_url
  for _ in $(seq 1 30); do
    if manifest="$(curl -fsS "$scene_url")"; then
      break
    fi
    sleep 2
  done
  [ -n "$manifest" ] || manifest="$(curl -fsS "$scene_url")"
  manifest_file="$(mktemp)"
  printf '%s' "$manifest" > "$manifest_file"
  glb_path="$(python3 - "$manifest_file" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1]))
glb_path = payload.get('glbPath')
if not isinstance(glb_path, str) or not glb_path:
    raise SystemExit('missing_glb_path')
print(glb_path)
PY
)"
  rm -f "$manifest_file"
  glb_url="$(url_join "$scene_url" "$glb_path")"
  for _ in $(seq 1 30); do
    if curl -fsSI "$glb_url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  curl -fsSI "$glb_url" >/dev/null
}

patch_room_scene_bundle() {
  local api_base="$1"
  local admin_token="$2"
  local room_id="$3"
  local scene_url="$4"
  local response_file
  local actual_url

  preflight_scene_url "$scene_url"
  response_file="$(mktemp)"
  curl -fsS -X PATCH "$api_base/api/rooms/$room_id" \
    -H 'content-type: application/json' \
    -H "x-noah-admin-token: $admin_token" \
    -d "{\"sceneBundleUrl\":\"$scene_url\"}" \
    > "$response_file"
  actual_url="$(python3 - "$response_file" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1]))
print(payload.get('sceneBundleUrl') or payload.get('manifest', {}).get('sceneBundle', {}).get('url') or '')
PY
)"
  rm -f "$response_file"
  if [ "$actual_url" != "$scene_url" ]; then
    echo "scene_bundle_url_mismatch:$room_id" >&2
    exit 1
  fi
  echo "scene_bundle_patched:$room_id:$scene_url"
}

patch_canonical_scene_bundles() {
  local api_port
  local api_base
  local admin_token
  local state_domain
  local asset_base
  local hall_room_id
  local blueoffice_room_id

  api_port="$(env_value NOAH_API_DIRECT_PORT)"
  admin_token="$(env_value CONTROL_PLANE_ADMIN_TOKEN)"
  state_domain="$(env_value NOAH_STATE_DOMAIN)"
  api_base="http://127.0.0.1:${api_port:-4000}"
  asset_base="https://$state_domain"
  hall_room_id="${STAGING_HALL_ROOM_ID:-42db8225-f671-4e46-9c28-9381d66a948c}"
  blueoffice_room_id="${STAGING_BLUEOFFICE_ROOM_ID:-0b537d34-7b92-4b51-854a-8c64cfb4c114}"

  if [ -z "$admin_token" ] || [ -z "$state_domain" ]; then
    echo "skip_scene_bundle_patch:missing_admin_token_or_state_domain"
    return 0
  fi

  wait_for_api "$api_base"
  patch_room_scene_bundle "$api_base" "$admin_token" "$hall_room_id" "$asset_base/assets/scenes/sense-hall2-v1/$IMAGE_TAG/scene.json"
  patch_room_scene_bundle "$api_base" "$admin_token" "$blueoffice_room_id" "$asset_base/assets/scenes/sense-blueoffice-glb-v4/$IMAGE_TAG/scene.json"
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
values.setdefault('REMOTE_BROWSER_IMAGE_REPO', 'cr.yandex/crp9cm29k6p76hqo8lti/noah-remote-browser')
public_remote_browser_origins = ['https://rutube.ru', 'https://*.rutube.ru', 'https://*.rtbcdn.ru']
if not values.get('NOAH_BROWSER_DOMAIN') and values.get('NOAH_APP_DOMAIN'):
    values['NOAH_BROWSER_DOMAIN'] = 'browser.' + values['NOAH_APP_DOMAIN']
if not values.get('REMOTE_BROWSER_PUBLIC_URL') and values.get('NOAH_BROWSER_DOMAIN'):
    values['REMOTE_BROWSER_PUBLIC_URL'] = 'https://' + values['NOAH_BROWSER_DOMAIN']
if not values.get('REMOTE_BROWSER_ALLOWED_ORIGINS'):
    allowed_origins = []
    if values.get('NOAH_APP_BASE_URL'):
        allowed_origins.append(values['NOAH_APP_BASE_URL'])
    if values.get('NOAH_APP_DOMAIN'):
        allowed_origins.append('https://' + values['NOAH_APP_DOMAIN'])
    values['REMOTE_BROWSER_ALLOWED_ORIGINS'] = ','.join(dict.fromkeys(allowed_origins))
configured_origins = [item.strip() for item in values.get('REMOTE_BROWSER_ALLOWED_ORIGINS', '').split(',') if item.strip()]
configured_origins.extend(public_remote_browser_origins)
values['REMOTE_BROWSER_ALLOWED_ORIGINS'] = ','.join(dict.fromkeys(configured_origins))
values.setdefault('REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS', 'false')
values.setdefault('REMOTE_BROWSER_FRAME_INTERVAL_MS', '250')
values.setdefault('REMOTE_BROWSER_TOKEN_SECRET', values.get('STATE_TOKEN_SECRET', 'dev-remote-browser-secret'))
values.setdefault('REMOTE_BROWSER_TOKEN_TTL_SECONDS', '300')
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

for key in ('API_IMAGE_REPO', 'ROOM_STATE_IMAGE_REPO', 'REMOTE_BROWSER_IMAGE_REPO', 'NOAH_BROWSER_DOMAIN', 'REMOTE_BROWSER_PUBLIC_URL', 'REMOTE_BROWSER_ALLOWED_ORIGINS', 'REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS', 'REMOTE_BROWSER_FRAME_INTERVAL_MS', 'REMOTE_BROWSER_TOKEN_SECRET', 'REMOTE_BROWSER_TOKEN_TTL_SECONDS', 'IMAGE_TAG'):
    if key not in seen:
        rendered.append(f'{key}={values[key]}')

env_path.write_text('\n'.join(rendered) + '\n')
PY

log_disk_state
cleanup_docker_state
log_disk_state

if [ -f "$ROOT_DIR/tools/snapshot-scene-assets.sh" ]; then
  STAGING_SCENE_BUNDLE_VERSION="$IMAGE_TAG" \
    STAGING_SCENE_IDS="${STAGING_SCENE_IDS:-sense-hall2-v1,sense-blueoffice-glb-v4}" \
    bash "$ROOT_DIR/tools/snapshot-scene-assets.sh"
fi

rollout_compose_service room-state
rollout_compose_service remote-browser
rollout_compose_service api
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --pull never --no-deps caddy
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" restart caddy
patch_canonical_scene_bundles
cleanup_docker_state
log_disk_state
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
