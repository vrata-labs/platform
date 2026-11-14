#!/usr/bin/env python3
"""Back up the accepted staging image with the same pinned storage foundation."""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


accepted = load_module("backup_accepted", "staging-accepted-release.py")
minio = load_module("backup_minio", "staging-minio-rollout.py")
remote = load_module("backup_remote", "staging-remote-release.py")
recovery = load_module("backup_recovery", "private-scene-recovery.py")


def capture(args, root):
    result = subprocess.run(args, cwd=root, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError("staging_backup_command_failed")
    return result.stdout.strip()


def backup(root, output_dir):
    root = Path(root).resolve()
    state = accepted.AcceptedState(root)
    # Same order as rollout: operation lock, then state lock. A shared state lock
    # also excludes standalone bind/publish calls throughout the database export.
    with remote.ReleaseHost(root).operation_lock(), state.locked(create=False, shared=True):
        return backup_locked(state, output_dir)


def backup_locked(state, output_dir):
    root = state.root
    release = state.preflight()["release"]
    env = root / "infra/docker/.env.staging"
    values = dict(line.split("=", 1) for line in env.read_text().splitlines()
                  if line and not line.startswith("#") and "=" in line)
    if values.get("IMAGE_TAG") != release["imageSha"]:
        raise ValueError("staging_backup_candidate_env")
    compose_file = root / "infra/docker/compose.staging.yml"
    compose = ["docker", "compose", "--env-file", str(env), "-f", str(compose_file)]
    container = capture(compose + ["ps", "-q", "api"], root)
    if not container or "\n" in container:
        raise ValueError("staging_backup_api_unavailable")
    image = capture(["docker", "inspect", "--format", "{{.Config.Image}}", container], root)
    if image != f'{values.get("API_IMAGE_REPO")}:{release["imageSha"]}':
        raise ValueError("staging_backup_working_image_mismatch")
    # A release accepted on the retired MinIO images is backed up with them (the override below); a newer
    # release runs exactly the storage images of its own Compose file.
    foundation = (release["foundationDigests"]["minio"], release["foundationDigests"]["minio-bootstrap"])
    legacy = foundation == (minio.PINNED_MINIO, minio.PINNED_MC)
    if not legacy:
        services = json.loads(capture(compose + ["config", "--format", "json"], root))["services"]
        if foundation != (services["minio"]["image"], services["minio-bootstrap"]["image"]):
            raise ValueError("staging_backup_foundation_mismatch")
    # The running storage and its one-shot client must be the accepted images, not only the declared ones.
    for service, expected in zip(("minio", "minio-bootstrap"), foundation):
        running = capture(compose + ["ps", "-a", "-q", service], root)
        if (not running or "\n" in running
                or capture(["docker", "inspect", "--format", "{{.Config.Image}}", running], root) != expected):
            raise ValueError("staging_backup_foundation_mismatch")
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    name = f'vrata-{timestamp}-{release["imageSha"]}'
    destination = output_dir / (".incomplete-" + name)
    published = output_dir / name
    if os.path.lexists(destination) or os.path.lexists(published):
        raise ValueError("staging_backup_destination_exists")
    before = recovery.metadata(state)
    try:
        with tempfile.TemporaryDirectory(prefix=".backup-compose-", dir=state.directory) as directory:
            compose_files = ["--compose-file", str(compose_file)]
            if legacy:
                override = Path(directory) / "minio.override.json"
                override.write_text(json.dumps({"services": {
                    "minio": {"image": minio.PINNED_MINIO},
                    "minio-bootstrap": {"image": minio.PINNED_MC}}}))
                override.chmod(0o600)
                compose_files += ["--compose-file", str(override)]
            command = ["node", str(root / "tools/backup-restore.mjs"), "backup",
                       "--env-file", str(env), *compose_files, "--image-tag", release["imageSha"],
                       "--accepted-release-file", str(state.manifest_path), "--backup-dir", str(destination)]
            if subprocess.run(command, cwd=root, check=False).returncode:
                raise RuntimeError("staging_backup_failed")
        if state.preflight()["release"] != release:
            raise ValueError("staging_backup_release_changed")
        recovery.attach(state, destination, before)
        for directory, _, files in os.walk(destination):
            Path(directory).chmod(0o700)
            for filename in files:
                (Path(directory) / filename).chmod(0o600)
        recovery.validate(destination)
        if state.preflight()["release"] != release or recovery.metadata(state) != before or capture(
                ["docker", "inspect", "--format", "{{.Config.Image}}", container], root) != image:
            raise ValueError("staging_backup_release_changed")
        # The generic retention scanner sees only vrata-* directories. An export
        # cannot count as one of its verified copies before scenes are complete.
        if os.path.lexists(published):
            raise ValueError("staging_backup_destination_exists")
        os.rename(destination, published)
    except BaseException:
        # Never let a partial export count as a verified recovery/retention point.
        manifest = destination / "manifest.json"
        if manifest.exists():
            manifest.rename(destination / "manifest.incomplete.json")
        if (destination / recovery.NAMESPACE).is_dir():
            shutil.rmtree(destination / recovery.NAMESPACE)
        raise
    return {"backupDir": str(published), "imageSha": release["imageSha"], "validated": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(backup(args.root, args.output_dir), sort_keys=True))
    except (ValueError, RuntimeError, OSError) as error:
        message = str(error)
        if not message.startswith(("staging_backup_", "private_scene_recovery_", "accepted_release_", "staging_json_")):
            message = "staging_backup_failed"
        raise SystemExit(message) from None
