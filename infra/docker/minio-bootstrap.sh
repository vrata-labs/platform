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

# SeaweedFS answers its health check before the filer lock is ready (about half a minute after a start) and
# refuses writes until then. Every step is idempotent and retried within a bounded budget.
attempts=${STORAGE_BOOTSTRAP_ATTEMPTS:-30}
retry() {
  n=1
  until "$@"; do
    [ "$n" -ge "$attempts" ] && return 1
    n=$((n + 1))
    sleep "${STORAGE_BOOTSTRAP_DELAY:-2}"
  done
}

retry mc alias set vrata "${MINIO_ENDPOINT:-http://minio:9000}" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
retry mc mb --ignore-existing "vrata/$ROOM_PLUGIN_BUCKET"
# SeaweedFS rejects removing a policy that does not exist, so remove only one that is there; a failed read
# (missing bucket, credentials, network) stops the bootstrap. The bucket must end up without any policy.
private_policy=$(retry mc anonymous get-json "vrata/$ROOM_PLUGIN_BUCKET")
if [ "$private_policy" != "{}" ]; then
  retry mc anonymous set none "vrata/$ROOM_PLUGIN_BUCKET"
  private_policy=$(retry mc anonymous get-json "vrata/$ROOM_PLUGIN_BUCKET")
fi
if [ "$private_policy" != "{}" ]; then
  printf '%s\n' 'room plugin bucket still has an anonymous policy' >&2
  exit 1
fi
retry mc mb --ignore-existing "vrata/$MINIO_BUCKET"
retry mc anonymous set download "vrata/$MINIO_BUCKET"

if [ -n "${MINIO_SCENE_PREFIX:-}" ]; then
  retry mc cp --attr "Content-Type=application/json" /seed/scene.json "vrata/$MINIO_BUCKET/${MINIO_SCENE_PREFIX}compose-smoke/scene.json"
fi
