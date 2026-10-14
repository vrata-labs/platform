#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || {
  printf '%s\n' 'usage: rollout-staging-images.sh <immutable-full-sha>' >&2
  exit 1
}
IMAGE_TAG="$1"
ROOT_DIR="${VRATA_STAGING_APP_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
ENV_FILE="$ROOT_DIR/infra/docker/.env.staging"
COMPOSE_FILE="$ROOT_DIR/infra/docker/compose.staging.yml"
[[ -f "$ENV_FILE" ]] || { printf '%s\n' 'missing_staging_env' >&2; exit 1; }

# Add the separate proxy proof for compatible targets without rotating sessions.
# Older portable rollback targets do not implement this identity boundary.
KEY_HELPER="$(dirname "$0")/staging-state-key.py"
if [[ ! -f "$KEY_HELPER" ]]; then KEY_HELPER="$ROOT_DIR/tools/staging-state-key.py"; fi
if [[ -f "$KEY_HELPER" ]]; then
  python3 -B "$KEY_HELPER" --env-file "$ENV_FILE" --ensure-proxy-key
fi

# Environment normalization never discovers addresses from a cloud metadata endpoint.
python3 - "$ENV_FILE" "$IMAGE_TAG" <<'PY'
import ipaddress
import os
from pathlib import Path
import secrets
import sys

path = Path(sys.argv[1])
values = {}
for line in path.read_text().splitlines():
    if line and not line.lstrip().startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        values[key] = value
public_ip = os.environ.get('VRATA_STAGING_PUBLIC_IP') or values.get('VRATA_STAGING_PUBLIC_IP') or values.get('LIVEKIT_NODE_IP')
try:
    public_ip = str(ipaddress.IPv4Address(public_ip))
except (ValueError, TypeError):
    raise SystemExit('staging_public_ip_required') from None
if values.get('LIVEKIT_NODE_IP') != public_ip:
    raise SystemExit('staging_public_ip_config_mismatch')
for key in ('VRATA_APP_DOMAIN', 'VRATA_STATE_DOMAIN', 'VRATA_LIVEKIT_DOMAIN', 'VRATA_BROWSER_DOMAIN', 'VRATA_STORAGE_DOMAIN'):
    if not values.get(key) or '..' in values[key] or values[key].endswith('.invalid'):
        raise SystemExit('staging_public_domain_required')
if not values.get('VRATA_STAGING_STATE_DIR') or not values.get('VRATA_STAGING_SCENE_ROOT'):
    raise SystemExit('staging_managed_scene_state_required')
internal = values.get('VRATA_INTERNAL_SERVICE_TOKEN', '').strip().strip('"').strip("'")
if len(internal) < 32 or internal.startswith('REPLACE_WITH_') or internal == 'unconfigured-read-only-preflight' or any(character.isspace() for character in internal):
    raise SystemExit('staging_internal_service_token_required')
values['IMAGE_TAG'] = sys.argv[2]
values['LIVEKIT_TURN_TLS_PORT'] = ''
values['LIVEKIT_TURN_EXTERNAL_TLS'] = 'false'
values.setdefault('REMOTE_BROWSER_TOKEN_SECRET', secrets.token_urlsafe(48))
path.write_text('\n'.join(f'{key}={value}' for key, value in values.items()) + '\n')
path.chmod(0o600)
PY

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
compose config --quiet

# The pinned MinIO compatibility helper wraps this command and supplies effective images.
for service in postgres livekit minio minio-bootstrap room-state remote-browser api caddy; do
  compose pull "$service"
done
compose up -d --no-build --pull never --wait postgres livekit minio
compose up --no-build --pull never --force-recreate minio-bootstrap
compose up -d --no-build --pull never --wait room-state remote-browser api

for service in room-state remote-browser api; do
  id=$(compose ps -q "$service")
  [[ -n "$id" ]] || { printf '%s\n' "service_container_missing:$service" >&2; exit 1; }
  expected=$(compose config --format json | python3 -c 'import json,sys;print(json.load(sys.stdin)["services"][sys.argv[1]]["image"])' "$service")
  actual=$(docker inspect --format '{{.Config.Image}}' "$id")
  [[ "$expected" == "$actual" && "$actual" == *":$IMAGE_TAG" ]] || {
    printf '%s\n' "running_image_tag_mismatch:$service" >&2
    exit 1
  }
done
compose up -d --no-build --pull never --force-recreate --wait caddy
compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
# Canonical room creation/patching belongs to the CI gate after public HTTPS health.
printf '%s\n' "running_image_tag_verified:$IMAGE_TAG"
