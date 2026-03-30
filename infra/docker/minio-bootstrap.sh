#!/bin/sh
set -eu

for _ in $(seq 1 30); do
  if mc alias set noah http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

mc alias set noah http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "noah/$MINIO_BUCKET"
mc anonymous set download "noah/$MINIO_BUCKET"

if [ -n "${MINIO_SCENE_PREFIX:-}" ]; then
  mc cp --attr "Content-Type=application/json" /seed/scene.json "noah/$MINIO_BUCKET/${MINIO_SCENE_PREFIX}compose-smoke/scene.json"
fi
