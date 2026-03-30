#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${1:-noah-staging-compose}"
ZONE="${YC_ZONE:-ru-central1-b}"
PLATFORM_ID="standard-v3"
CORES="2"
MEMORY="4GB"
IMAGE_FAMILY="ubuntu-2204-lts"
IMAGE_FOLDER="standard-images"
USER_DATA_FILE="infra/yandex/cloud-init/staging-compose.yaml"
SSH_KEY_FILE="${YC_SSH_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
SSH_LOGIN="${YC_SSH_LOGIN:-$USER}"
TEMP_USER_DATA_FILE=""

cleanup() {
  if [ -n "$TEMP_USER_DATA_FILE" ] && [ -f "$TEMP_USER_DATA_FILE" ]; then
    rm -f "$TEMP_USER_DATA_FILE"
  fi
}

trap cleanup EXIT

USER_DATA_TO_USE="$USER_DATA_FILE"

if [ -f "$SSH_KEY_FILE" ]; then
  SSH_KEY_CONTENT="$(tr -d '\n' < "$SSH_KEY_FILE")"
  TEMP_USER_DATA_FILE="$(mktemp)"
  cat "$USER_DATA_FILE" > "$TEMP_USER_DATA_FILE"
  cat >> "$TEMP_USER_DATA_FILE" <<EOF

users:
  - default
  - name: ${SSH_LOGIN}
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: sudo,docker
    ssh_authorized_keys:
      - ${SSH_KEY_CONTENT}
EOF
  USER_DATA_TO_USE="$TEMP_USER_DATA_FILE"
fi

YC_ARGS=(
  compute instance create
  --name "$INSTANCE_NAME"
  --zone "$ZONE"
  --platform-id "$PLATFORM_ID"
  --create-boot-disk image-folder-id="$IMAGE_FOLDER",image-family="$IMAGE_FAMILY",size=20GB
  --cores "$CORES"
  --memory "$MEMORY"
  --network-interface subnet-name=default-"$ZONE",nat-ip-version=ipv4
  --metadata-from-file user-data="$USER_DATA_TO_USE"
)

yc "${YC_ARGS[@]}"
