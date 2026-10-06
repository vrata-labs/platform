#!/bin/sh
set -eu

: "${MINIO_BUCKET:?MINIO_BUCKET is required}"
: "${ROOM_PLUGIN_BUCKET:?ROOM_PLUGIN_BUCKET is required}"
validate_bucket() {
  case "$1" in *[!a-z0-9.-]*|[-.]*|*[-.]|*..*) printf '%s\n' 'invalid storage bucket namespace' >&2; exit 1;; esac
  if [ "${#1}" -lt 3 ] || [ "${#1}" -gt 63 ]; then
    printf '%s\n' 'invalid storage bucket namespace' >&2; exit 1
  fi
}
validate_bucket "$MINIO_BUCKET"
validate_bucket "$ROOM_PLUGIN_BUCKET"
if [ "$MINIO_BUCKET" = "$ROOM_PLUGIN_BUCKET" ]; then
  printf '%s\n' 'room plugins require a separate private bucket' >&2
  exit 1
fi

for _ in $(seq 1 30); do
  if mc alias set vrata "${MINIO_ENDPOINT:-http://minio:9000}" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

mc alias set vrata "${MINIO_ENDPOINT:-http://minio:9000}" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "vrata/$ROOM_PLUGIN_BUCKET"
mc anonymous set none "vrata/$ROOM_PLUGIN_BUCKET"
mc mb --ignore-existing "vrata/$MINIO_BUCKET"
mc anonymous set download "vrata/$MINIO_BUCKET"

if [ -n "${MINIO_SCENE_PREFIX:-}" ]; then
  mc cp --attr "Content-Type=application/json" /seed/scene.json "vrata/$MINIO_BUCKET/${MINIO_SCENE_PREFIX}compose-smoke/scene.json"
fi
