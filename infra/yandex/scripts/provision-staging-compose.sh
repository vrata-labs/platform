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

yc compute instance create \
  --name "$INSTANCE_NAME" \
  --zone "$ZONE" \
  --platform-id "$PLATFORM_ID" \
  --create-boot-disk image-folder-id="$IMAGE_FOLDER",image-family="$IMAGE_FAMILY",size=20GB \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --network-interface subnet-name=default-"$ZONE",nat-ip-version=ipv4 \
  --metadata-from-file user-data="$USER_DATA_FILE"
