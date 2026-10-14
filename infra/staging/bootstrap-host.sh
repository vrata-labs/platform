#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bootstrap-host.sh --public-ip IPv4 --ssh-public-key FILE [--app-dir /opt/vrata] [--deploy-user vrata] [--helpers-dir DIR]'
}

APP_DIR=/opt/vrata
DEPLOY_USER=vrata
PUBLIC_IP=
PUBLIC_KEY=
HELPERS_DIR=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-ip) PUBLIC_IP="$2"; shift 2 ;;
    --ssh-public-key) PUBLIC_KEY="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --deploy-user) DEPLOY_USER="$2"; shift 2 ;;
    --helpers-dir) HELPERS_DIR="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done
[[ $(id -u) -eq 0 ]] || { printf '%s\n' 'bootstrap_requires_root' >&2; exit 1; }
[[ -n "$PUBLIC_IP" && -f "$PUBLIC_KEY" ]] || { usage >&2; exit 1; }
[[ "$APP_DIR" == /opt/* && "$APP_DIR" != /opt/ && "$APP_DIR" != *'..'* && "$APP_DIR" != *' '* ]] || exit 1
[[ "$DEPLOY_USER" =~ ^[a-z][a-z0-9_-]*$ ]] || exit 1
[[ $(uname -r) != *[Mm]icrosoft* ]] || { printf '%s\n' 'bootstrap_requires_dedicated_linux_host' >&2; exit 1; }
python3 -c 'import ipaddress,sys; ipaddress.IPv4Address(sys.argv[1])' "$PUBLIC_IP"
STATE_DIR="${APP_DIR}-stage-state"
if [[ -e "$STATE_DIR/public-ip" ]]; then
  [[ "$(<"$STATE_DIR/public-ip")" == "$PUBLIC_IP" ]] || { printf '%s\n' 'bootstrap_existing_host_mismatch' >&2; exit 1; }
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg python3 sudo docker.io docker-compose-v2 ufw
if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') != 22 ]]; then
  install -d -m 0755 /etc/apt/keyrings
  curl --fail --silent --show-error https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
systemctl enable --now docker
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
HOME_DIR=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh"
if [[ ! -f "$HOME_DIR/.ssh/authorized_keys" ]]; then
  install -m 0600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$PUBLIC_KEY" "$HOME_DIR/.ssh/authorized_keys"
elif ! grep -Fqx -- "$(tr -d '\r\n' < "$PUBLIC_KEY")" "$HOME_DIR/.ssh/authorized_keys"; then
  printf '\n%s\n' "$(tr -d '\r\n' < "$PUBLIC_KEY")" >> "$HOME_DIR/.ssh/authorized_keys"
fi
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$DEPLOY_USER" > "/etc/sudoers.d/vrata-$DEPLOY_USER"
chmod 0440 "/etc/sudoers.d/vrata-$DEPLOY_USER"
visudo -cf "/etc/sudoers.d/vrata-$DEPLOY_USER"

if [[ ! -e "$APP_DIR" ]]; then
  install -d -m 0755 "$APP_DIR"
  git clone --depth 1 https://github.com/vrata-labs/platform.git "$APP_DIR"
else
  [[ -d "$APP_DIR/.git" ]] || { printf '%s\n' 'bootstrap_checkout_not_owned' >&2; exit 1; }
fi
install -d -m 0700 "$STATE_DIR"
printf '%s\n' "$PUBLIC_IP" > "$STATE_DIR/public-ip"
chmod 0600 "$STATE_DIR/public-ip"
HELPERS_DIR="${HELPERS_DIR:-$APP_DIR/tools}"
[[ -f "$HELPERS_DIR/bootstrap-staging-host-env.py" ]] || { printf '%s\n' 'bootstrap_host_helpers_required' >&2; exit 1; }
IMAGE_SHA=$(git -C "$APP_DIR" rev-parse HEAD)
python3 -B "$HELPERS_DIR/bootstrap-staging-host-env.py" --root "$APP_DIR" --public-ip "$PUBLIC_IP" --image-sha "$IMAGE_SHA"
install -d -m 0700 "$STATE_DIR/bootstrap-tools"
for helper in staging-accepted-release.py staging-remote-release.py staging-template-catalog.py staging-minio-rollout.py staging_gate_proof.py staging_scene_files.py; do
  install -m 0600 "$HELPERS_DIR/$helper" "$STATE_DIR/bootstrap-tools/$helper"
done

# Docker-published services are constrained by the Compose bindings as well.
# This is a dedicated staging host; leave SSH reachable before enabling ufw.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 7882/udp
ufw allow 3478/udp
ufw allow 50000:50100/udp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
docker version --format '{{.Server.Version}}'
docker compose version
node --version
printf '%s\n' 'host_prepared_application_not_deployed'
