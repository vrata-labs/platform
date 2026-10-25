#!/usr/bin/env bash
# Platform stand recipe for tools/vrata-stage.py: the tool creates and removes the server,
# this hook says what runs on it. Phases:
#   user-data  print cloud-config: administrator and CI keys of the user vrata
#   prepare    bootstrap-host.sh, then the repository admin token in the private env
#   deploy     first verified Staging Deploy of STAGE_DEPLOY_SHA on the new host (Wave 2 catalog), then the
#              gated activation of the reference catalog on the same SHA
# Inputs (files): STAGE_ADMIN_PUBKEY, STAGE_CI_PUBKEY, STAGE_ADMIN_TOKEN; secrets never enter user-data.
set -euo pipefail
phase=${1:?usage: on-demand-hook.sh user-data|prepare|deploy}
remote() { ssh -F "$STAGE_SSH_CONFIG" "$STAGE_SSH_ALIAS" "$@"; }

case $phase in
  user-data)
    admin_key=$(tr -d '\n' <"$STAGE_ADMIN_PUBKEY")
    ci_key=$(tr -d '\n' <"$STAGE_CI_PUBKEY")
    cat <<EOF
#cloud-config
hostname: ${STAGE_SERVER_NAME}
disable_root: true
ssh_pwauth: false
users:
  - name: vrata
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    ssh_authorized_keys:
      - ${admin_key}
      - ${ci_key}
EOF
    ;;
  prepare)
    remote 'cat > /tmp/vrata-ci.pub' <"$STAGE_CI_PUBKEY"
    remote "sudo bash -s -- --public-ip '$STAGE_PUBLIC_IP' --ssh-public-key /tmp/vrata-ci.pub" <infra/staging/bootstrap-host.sh
    # bootstrap generates a random admin token; CI calls the API with the STAGING_ADMIN_TOKEN secret.
    remote 'cat > /tmp/vrata-admin-token.py' <<'PY'
import os, re, sys
path, token = sys.argv[1], sys.stdin.read().strip()
if not re.fullmatch(r"[A-Za-z0-9_-]{32,}", token):
    raise SystemExit("admin_token_invalid")
lines = open(path).read().splitlines()
lines = [line for line in lines if not line.startswith("CONTROL_PLANE_ADMIN_TOKEN=")] + ["CONTROL_PLANE_ADMIN_TOKEN=" + token]
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write("\n".join(lines) + "\n")
os.replace(tmp, path)
print("admin_token_configured")
PY
    remote "sudo python3 /tmp/vrata-admin-token.py /opt/vrata/infra/docker/.env.staging && rm -f /tmp/vrata-admin-token.py /tmp/vrata-ci.pub" <"$STAGE_ADMIN_TOKEN"
    ;;
  deploy)
    # A new host has no accepted release: bootstrap, and raise the identity floor before the first gate.
    python3 -B "$VRATA_STAGE_BIN" dispatch --repo "$STAGE_REPO" --workflow staging-deploy.yml \
      -f "deploy_sha=$STAGE_DEPLOY_SHA" -f bootstrap=true -f "activate_identity_v2=${STAGE_IDENTITY_V2:-true}"
    # Its first gate runs on the Wave 2 catalog and records the Wave 2 marker; the reference catalog that the full
    # staging suite expects is activated only by its own gated transition on the accepted image.
    python3 -B "$VRATA_STAGE_BIN" dispatch --repo "$STAGE_REPO" --workflow template-catalog.yml \
      -f operation=activate -f "expected_image_sha=$STAGE_DEPLOY_SHA"
    ;;
  *)
    echo "unknown phase: $phase" >&2
    exit 2
    ;;
esac
