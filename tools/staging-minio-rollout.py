#!/usr/bin/env python3
"""Run the checked-out rollout with checksum-pinned MinIO images from YCR.

Copied outside the checkout by staging-deploy.yml so older image SHAs remain
usable. Only the exact retired Docker Hub and Quay references are translated.
The original Compose file is restored even if rollout fails or receives SIGTERM/SIGINT.
"""

import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile


PINNED_MINIO = "cr.yandex/crp9cm29k6p76hqo8lti/vrata-minio@sha256:c83dd50c5efe2e3a962711a7c9fc77acfc55c3dad229da2146489f604afba387"
PINNED_MC = "cr.yandex/crp9cm29k6p76hqo8lti/vrata-mc@sha256:d535999f5c4eb01c9c06bd0c068d4bb8f7366a8469fe57e394907190f7feb550"

IMAGES = {
    "minio/minio:RELEASE.2025-02-28T09-55-16Z": PINNED_MINIO,
    "quay.io/minio/minio:RELEASE.2025-02-28T09-55-16Z@sha256:a929054ae025fa7997857cd0e2a2e3029238e31ad89877326dc032f4c1a14259": PINNED_MINIO,
    "minio/mc:RELEASE.2025-03-12T17-29-24Z": PINNED_MC,
    "quay.io/minio/mc:RELEASE.2025-03-12T17-29-24Z@sha256:470f5546b596e16c7816b9c3fa7a78ce4076bb73c2c73f7faeec0c8043923123": PINNED_MC,
}


def compatible_compose(content: bytes) -> bytes:
    for old, new in IMAGES.items():
        # Match image values only, not comments, environment values or new releases.
        pattern = rb"(?m)^([ \t]+image:[ \t]*)" + re.escape(old.encode()) + rb"([ \t]*(?:#[^\r\n]*)?)(?=\r?$)"
        content = re.sub(pattern, lambda match: match[1] + new.encode() + match[2], content)
    return content


def replace_file(path: Path, content: bytes, mode: int) -> None:
    fd, name = tempfile.mkstemp(prefix=".minio-compose-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
            os.fchmod(output.fileno(), mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main() -> int:
    if len(sys.argv) != 3 or not re.fullmatch(r"[0-9a-f]{40}", sys.argv[2]):
        raise SystemExit("usage: staging-minio-rollout.py <rollout-staging-images.sh> <full-image-sha>")
    script = Path(sys.argv[1]).resolve(strict=True)
    if script.name != "rollout-staging-images.sh":
        raise SystemExit("unexpected_staging_rollout_script")
    compose = script.with_name("compose.staging.yml")
    original = compose.read_bytes()
    mode = stat.S_IMODE(compose.stat().st_mode)
    translated = compatible_compose(original)
    changed = translated != original
    process = None

    def forward_signal(signum, _frame):
        if process is None:
            raise SystemExit(128 + signum)
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass

    previous = {sig: signal.signal(sig, forward_signal) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        if changed:
            replace_file(compose, translated, mode)
            print("staging_minio_registry_compat:applied", flush=True)
        process = subprocess.Popen(["bash", str(script), sys.argv[2]], start_new_session=True)
        code = process.wait()
        return code if code >= 0 else 128 - code
    finally:
        if changed:
            replace_file(compose, original, mode)
            print("staging_minio_registry_compat:restored", flush=True)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    sys.exit(main())
