#!/bin/sh
# Entrypoint of the bundled S3 storage (compose service `minio`, SeaweedFS since MinIO community was archived).
# The service keeps its name and port 9000, so the API endpoint, plugin storage fingerprints and accepted
# releases do not change. Its single S3 identity is the existing MINIO_ROOT_USER/MINIO_ROOT_PASSWORD pair.
set -eu

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
# The values go into JSON verbatim: allow printable ASCII only, without quotes or backslashes.
for value in "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do
  case "$value" in
    *[!\ -~]*|*\"*|*\\*)
      printf '%s\n' 'storage credentials must be printable ASCII without quotes or backslashes' >&2
      exit 1
      ;;
  esac
done
if [ "${#MINIO_ROOT_USER}" -lt 3 ] || [ "${#MINIO_ROOT_PASSWORD}" -lt 8 ]; then
  printf '%s\n' 'storage credentials are too short' >&2
  exit 1
fi

config=/tmp/vrata-storage
umask 077
rm -rf "$config"
mkdir "$config"
printf '{"identities":[{"name":"vrata","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}\n' \
  "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" > "$config/s3.json"
# The image entrypoint drops to the seaweed user before starting the server.
chown -R seaweed:seaweed "$config"

exec /entrypoint.sh server -dir=/data -ip=minio -ip.bind=0.0.0.0 \
  -master.volumeSizeLimitMB=1024 -volume.max=0 \
  -s3 -s3.port=9000 -s3.config="$config/s3.json"
