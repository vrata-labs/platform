#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <image-sha-tag>" >&2
  exit 1
fi

IMAGE_TAG="$1"
if [[ ! "$IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]]; then
  echo "invalid_image_tag: expected immutable full sha tag" >&2
  exit 1
fi

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

ensure_compose_foundation() {
  local service
  for service in postgres livekit minio minio-bootstrap; do
    pull_compose_service "$service"
  done
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --pull never postgres livekit minio
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up --no-build --pull never --force-recreate minio-bootstrap
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

sync_private_scene_assets() {
  local private_assets_root="${VRATA_PRIVATE_SCENE_ASSETS_ROOT:-${NOAH_PRIVATE_SCENE_ASSETS_ROOT:-/opt/vrata-private-scene-assets/assets}}"
  if [ ! -f "$private_assets_root/manifest.json" ] && [ -f "/opt/noah-private-scene-assets/assets/manifest.json" ]; then
    private_assets_root="/opt/noah-private-scene-assets/assets"
  fi

  if [ ! -f "$private_assets_root/manifest.json" ]; then
    echo "missing_private_scene_assets_manifest:$private_assets_root/manifest.json" >&2
    exit 2
  fi
  python3 - "$private_assets_root" "$ROOT_DIR/apps/runtime-web/public/assets/scenes" <<'PY'
import json
import shutil
import sys
from pathlib import Path

private_assets_root = Path(sys.argv[1]).resolve()
target_scene_root = Path(sys.argv[2]).resolve()
manifest = json.loads((private_assets_root / 'manifest.json').read_text())
if manifest.get('schemaVersion') != 1 or not isinstance(manifest.get('scenesRoot'), str) or not isinstance(manifest.get('scenes'), list):
    raise SystemExit('invalid_private_scene_manifest')

source_scene_root = private_assets_root / manifest['scenesRoot']
synced = []
for scene in manifest['scenes']:
    scene_dir = scene.get('sceneDir') or scene.get('sceneId')
    allowed_public_scene_dirs = {'livadia-nicholas-office-v1', 'the-hall-v1', 'the-office-v1'}
    if not isinstance(scene_dir, str) or not (scene_dir.startswith('sense-') or scene_dir in allowed_public_scene_dirs):
        raise SystemExit(f'invalid_private_scene_dir:{scene_dir}')
    shutil.copytree(source_scene_root / scene_dir, target_scene_root / scene_dir, dirs_exist_ok=True)
    synced.append(scene_dir)

print(f'synced_private_scene_assets:{len(synced)}')
for scene_dir in sorted(synced):
    print(f'- {scene_dir}')
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
    -H "x-vrata-admin-token: $admin_token" \
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

  api_port="$(env_value VRATA_API_DIRECT_PORT)"
  admin_token="$(env_value CONTROL_PLANE_ADMIN_TOKEN)"
  state_domain="$(env_value VRATA_STATE_DOMAIN)"
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

VRATA_STAGING_PUBLIC_IP="${VRATA_STAGING_PUBLIC_IP:-}"
if [ -z "$VRATA_STAGING_PUBLIC_IP" ]; then
  VRATA_STAGING_PUBLIC_IP="$(curl -fsH 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)"
fi
export VRATA_STAGING_PUBLIC_IP

python3 - "$ENV_FILE" "$IMAGE_TAG" <<'PY'
from pathlib import Path
import os
import secrets
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

values.setdefault('API_IMAGE_REPO', 'cr.yandex/crp9cm29k6p76hqo8lti/vrata-api')
values.setdefault('ROOM_STATE_IMAGE_REPO', 'cr.yandex/crp9cm29k6p76hqo8lti/vrata-room-state')
values.setdefault('REMOTE_BROWSER_IMAGE_REPO', 'cr.yandex/crp9cm29k6p76hqo8lti/vrata-remote-browser')
for key, legacy_name, current_name in (
    ('API_IMAGE_REPO', 'noah-api', 'vrata-api'),
    ('ROOM_STATE_IMAGE_REPO', 'noah-room-state', 'vrata-room-state'),
    ('REMOTE_BROWSER_IMAGE_REPO', 'noah-remote-browser', 'vrata-remote-browser'),
):
    if legacy_name in values.get(key, ''):
        values[key] = values[key].replace(legacy_name, current_name)
for legacy_key, current_key in (
    ('NOAH_APP_BASE_URL', 'VRATA_APP_BASE_URL'),
    ('NOAH_APP_DOMAIN', 'VRATA_APP_DOMAIN'),
    ('NOAH_STATE_DOMAIN', 'VRATA_STATE_DOMAIN'),
    ('NOAH_LIVEKIT_DOMAIN', 'VRATA_LIVEKIT_DOMAIN'),
    ('NOAH_BROWSER_DOMAIN', 'VRATA_BROWSER_DOMAIN'),
    ('NOAH_DEV_ROLE_QUERY', 'VRATA_DEV_ROLE_QUERY'),
    ('NOAH_INTERNAL_SERVICE_TOKEN', 'VRATA_INTERNAL_SERVICE_TOKEN'),
    ('NOAH_HTTP_PORT', 'VRATA_HTTP_PORT'),
    ('NOAH_HTTPS_PORT', 'VRATA_HTTPS_PORT'),
    ('NOAH_API_DIRECT_PORT', 'VRATA_API_DIRECT_PORT'),
    ('NOAH_ROOM_STATE_PORT', 'VRATA_ROOM_STATE_PORT'),
    ('NOAH_LIVEKIT_PORT', 'VRATA_LIVEKIT_PORT'),
    ('NOAH_LIVEKIT_TCP_PORT', 'VRATA_LIVEKIT_TCP_PORT'),
    ('NOAH_LIVEKIT_UDP_PORT', 'VRATA_LIVEKIT_UDP_PORT')
):
    if current_key not in values and legacy_key in values:
        values[current_key] = values[legacy_key]
public_ip = os.environ.get('VRATA_STAGING_PUBLIC_IP', '').strip()
if public_ip:
    app_domain = f'{public_ip}.sslip.io'
    state_domain = f'state.{app_domain}'
    livekit_domain = f'livekit.{app_domain}'
    browser_domain = f'browser.{app_domain}'
    values.update({
        'VRATA_APP_BASE_URL': f'https://{app_domain}',
        'VRATA_APP_DOMAIN': app_domain,
        'VRATA_STATE_DOMAIN': state_domain,
        'VRATA_LIVEKIT_DOMAIN': livekit_domain,
        'VRATA_BROWSER_DOMAIN': browser_domain,
        'LIVEKIT_NODE_IP': public_ip,
        'ROOM_STATE_PUBLIC_URL': f'wss://{state_domain}',
        'LIVEKIT_URL': f'wss://{livekit_domain}',
        'VRATA_LIVEKIT_TCP_PORT': values.get('VRATA_LIVEKIT_TCP_PORT') or values.get('VRATA_LIVEKIT_UDP_PORT') or '7881',
        'LIVEKIT_TURN_ENABLED': values.get('LIVEKIT_TURN_ENABLED') or 'false',
        'VRATA_ALLOW_INSECURE_PRODUCTION_URLS': 'false',
        'REMOTE_BROWSER_PUBLIC_URL': f'https://{browser_domain}',
        'REMOTE_BROWSER_ALLOWED_ORIGINS': ','.join([
            f'https://{app_domain}',
            f'http://{public_ip}:4000',
            'http://127.0.0.1:4000',
            'http://localhost:4000'
        ]),
        'MINIO_PUBLIC_BASE_URL': f'http://{public_ip}:9000'
    })
    if values.get('LIVEKIT_API_KEY', '').strip().lower() in ('', 'devkey'):
        values['LIVEKIT_API_KEY'] = 'vrata-stage'
    if values.get('LIVEKIT_API_SECRET', '').strip().lower() in ('', 'secret', 'devsecret'):
        values['LIVEKIT_API_SECRET'] = secrets.token_urlsafe(32)
public_remote_browser_origins = ['https://rutube.ru', 'https://*.rutube.ru', 'https://*.rtbcdn.ru']
if not values.get('VRATA_BROWSER_DOMAIN') and values.get('VRATA_APP_DOMAIN'):
    values['VRATA_BROWSER_DOMAIN'] = 'browser.' + values['VRATA_APP_DOMAIN']
if not values.get('REMOTE_BROWSER_PUBLIC_URL') and values.get('VRATA_BROWSER_DOMAIN'):
    values['REMOTE_BROWSER_PUBLIC_URL'] = 'https://' + values['VRATA_BROWSER_DOMAIN']
if not values.get('REMOTE_BROWSER_ALLOWED_ORIGINS'):
    allowed_origins = []
    if values.get('VRATA_APP_BASE_URL'):
        allowed_origins.append(values['VRATA_APP_BASE_URL'])
    if values.get('VRATA_APP_DOMAIN'):
        allowed_origins.append('https://' + values['VRATA_APP_DOMAIN'])
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

for key in ('API_IMAGE_REPO', 'ROOM_STATE_IMAGE_REPO', 'REMOTE_BROWSER_IMAGE_REPO', 'VRATA_APP_BASE_URL', 'VRATA_APP_DOMAIN', 'VRATA_STATE_DOMAIN', 'VRATA_LIVEKIT_DOMAIN', 'VRATA_BROWSER_DOMAIN', 'VRATA_DEV_ROLE_QUERY', 'VRATA_INTERNAL_SERVICE_TOKEN', 'VRATA_ALLOW_INSECURE_PRODUCTION_URLS', 'VRATA_HTTP_PORT', 'VRATA_HTTPS_PORT', 'VRATA_API_DIRECT_PORT', 'VRATA_ROOM_STATE_PORT', 'VRATA_LIVEKIT_PORT', 'VRATA_LIVEKIT_TCP_PORT', 'VRATA_LIVEKIT_UDP_PORT', 'LIVEKIT_NODE_IP', 'ROOM_STATE_PUBLIC_URL', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_TURN_ENABLED', 'REMOTE_BROWSER_PUBLIC_URL', 'REMOTE_BROWSER_ALLOWED_ORIGINS', 'REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS', 'REMOTE_BROWSER_FRAME_INTERVAL_MS', 'REMOTE_BROWSER_TOKEN_SECRET', 'REMOTE_BROWSER_TOKEN_TTL_SECONDS', 'MINIO_PUBLIC_BASE_URL', 'IMAGE_TAG'):
    if key not in seen and key in values:
        rendered.append(f'{key}={values[key]}')

env_path.write_text('\n'.join(rendered) + '\n')
PY

log_disk_state
cleanup_docker_state
log_disk_state

sync_private_scene_assets

if [ -f "$ROOT_DIR/tools/snapshot-scene-assets.sh" ]; then
  STAGING_SCENE_BUNDLE_VERSION="$IMAGE_TAG" \
    STAGING_SCENE_IDS="${STAGING_SCENE_IDS:-sense-hall2-v1,sense-blueoffice-glb-v4}" \
    bash "$ROOT_DIR/tools/snapshot-scene-assets.sh"
fi

ensure_compose_foundation
rollout_compose_service room-state
rollout_compose_service remote-browser
rollout_compose_service api
pull_compose_service caddy
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --pull never --no-deps caddy
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" restart caddy
patch_canonical_scene_bundles
cleanup_docker_state
log_disk_state
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
