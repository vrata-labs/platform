# Private room-plugin storage

Room-plugin source artifacts use ROOM_PLUGIN_BUCKET, never MINIO_BUCKET or
SCENE_BUNDLE_S3_BUCKET. All compose API/bootstrap services default to
vrata-room-plugins; the namespace must differ from public scene/document buckets.
The API reuses existing storage endpoint, region and credentials only. No public
URL or boolean privacy declaration can substitute for this private namespace.

## Provisioning

MinIO bootstrap creates the private bucket idempotently and applies anonymous
none before applying the existing public bucket's anonymous download policy and
scene seed. Equal or malformed bucket names stop bootstrap before any policy
change. Public scenes/documents retain their existing download policy.

For s3-compatible storage, the operator must create ROOM_PLUGIN_BUCKET and deny
anonymous object reads before use. The API does not fall back to a public bucket
or configure provider IAM generically. Signed PUT/GET/DELETE must work with the
configured credentials. Existing metadata's immutable backend fingerprint binds
the actual bucket; changing this variable cannot silently retarget old records.
Previously public artifacts require explicit tracked-key cleanup/migration by a
trusted operator. This check does not migrate or collect historical objects.

## Deployed verification

Run after the exact commit is published by the normal git/CI staging pipeline and
MinIO bootstrap has completed. From the deployed checkout, using its staging env:

```sh
docker compose --env-file infra/docker/.env.staging -f infra/docker/compose.staging.yml exec -T api node apps/api/dist/plugins/verify-private-storage.js
```

The API container working directory is /app. The compiled Node probe uses its
POSTGRES_URL and runtime storage configuration; it does not expose an HTTP author
or fixture endpoint and does not hot-migrate the database. It creates only a
server-owned UUID private room and one fixed benign SDK artifact. No plugin code
is executed, no binding is created and no package is published.

The probe requires byte-exact signed GET after acknowledged signed PUT, then an
unsigned GET returning exactly 403 against the actual storage endpoint. 200,
404, redirects, 5xx and network failures fail verification. For MinIO it also
checks the existing MINIO_PUBLIC_BASE_URL through the storage reverse proxy.
ROOM_PLUGIN_ANONYMOUS_ENDPOINT may specify another external storage endpoint
(without bucket suffix); it is additional to, never a replacement for, the direct
unsigned check. All API compose variants explicitly forward this optional field;
an env-file alone does not inject arbitrary variables into containers. Missing,
empty or whitespace-only overrides fall back to MINIO_PUBLIC_BASE_URL for MinIO.
For custom S3, an absent/blank override means only the mandatory direct check;
there is no inferred mapping from public assets URLs. Nonblank overrides are
trimmed and used as supplied: invalid/unreachable routes fail verification, with
no automatic hostname/IP replacement. Ensure the route is reachable from the API
container; local loopback-only public URLs may need an explicitly reachable override.

Successful checks delete the acknowledged fixture blob, its metadata and its
room. Unknown PUT outcomes preserve the reserved index and room; timeout/abort
is never proof that the remote writer has stopped. No generic orphan collector
or bucket scan is used. Output is boolean checks only: no credentials, URLs,
room IDs, object keys, bytes or fingerprints. A failed check exits nonzero.
