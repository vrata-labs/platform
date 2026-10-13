#!/usr/bin/env python3
"""Read, publish and repair accepted staging state outside the git checkout."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from staging_gate_proof import checked_sha, load_gate_proof, read_json
from staging_scene_files import verify_snapshot


FOUNDATIONS = {"postgres", "livekit", "minio", "minio-bootstrap", "caddy"}
RELEASE_KEYS = {"schemaVersion", "imageSha", "assetSha", "snapshotId", "foundationDigests", "runId", "runAttempt"}


class PublicationUnconfirmed(RuntimeError):
    """The rename completed; callers must inspect committed state before recovery."""


def regular_file_exists(path):
    try:
        metadata = Path(path).lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("accepted_release_file_not_regular")
    return True


def host_identity():
    value = Path("/etc/machine-id").read_text().strip()
    if not value:
        raise ValueError("accepted_release_host_identity_missing")
    return hashlib.sha256(value.encode()).hexdigest()


def atomic_write(path, content):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".staging-state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        try:
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError:
            raise PublicationUnconfirmed("accepted_release_publication_unconfirmed") from None
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_release(release):
    if not isinstance(release, dict) or set(release) != RELEASE_KEYS:
        raise ValueError("accepted_release_invalid_schema")
    if type(release["schemaVersion"]) is not int or release["schemaVersion"] != 1:
        raise ValueError("accepted_release_invalid_schema")
    checked_sha(release["imageSha"])
    checked_sha(release["assetSha"])
    if release["snapshotId"] != f'{release["imageSha"]}-{release["assetSha"]}':
        raise ValueError("accepted_release_invalid_snapshot")
    digests = release["foundationDigests"]
    if not isinstance(digests, dict) or set(digests) != FOUNDATIONS:
        raise ValueError("accepted_release_invalid_foundations")
    if any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}", value)
           for value in digests.values()):
        raise ValueError("accepted_release_invalid_digest")
    if not isinstance(release["runId"], str) or not re.fullmatch(r"[1-9][0-9]*", release["runId"]):
        raise ValueError("accepted_release_invalid_run")
    if type(release["runAttempt"]) is not int or release["runAttempt"] < 1:
        raise ValueError("accepted_release_invalid_run")
    return release


class AcceptedState:
    def __init__(self, root, state_dir=None):
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise ValueError("accepted_release_invalid_root")
        self.directory = Path(state_dir).resolve() if state_dir else self.root.with_name(self.root.name + "-stage-state")
        if self.directory.is_relative_to(self.root):
            raise ValueError("accepted_release_state_inside_checkout")
        self.manifest_path = self.directory / "accepted-release.json"
        self.designation_path = self.directory / "bootstrap-host.json"
        self.legacy_path = self.root / "infra/docker/.staging-successful-image-tag"

    @contextmanager
    def locked(self, create=True, shared=False):
        if create:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = self.directory / ".state.lock"
        if not create and not regular_file_exists(lock):
            if regular_file_exists(self.manifest_path):
                raise ValueError("accepted_release_lock_missing")
            yield
            return
        flags = os.O_NOFOLLOW | (os.O_CREAT | os.O_RDWR if create else os.O_RDONLY)
        fd = os.open(lock, flags, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def manifest(self):
        return validate_release(read_json(self.manifest_path)) if regular_file_exists(self.manifest_path) else None

    def legacy(self):
        try:
            if not regular_file_exists(self.legacy_path):
                return None
            return checked_sha(self.legacy_path.read_text().strip())
        except (ValueError, UnicodeError):
            raise ValueError("accepted_release_legacy_invalid") from None

    def designate(self, public_ip, identity=None):
        try:
            public_ip = str(ipaddress.IPv4Address(public_ip))
        except ipaddress.AddressValueError:
            raise ValueError("accepted_release_invalid_public_ip") from None
        expected = {"schemaVersion": 1, "publicIp": public_ip, "hostId": identity or host_identity(), "root": str(self.root)}
        if not re.fullmatch(r"[a-f0-9]{64}", expected["hostId"]):
            raise ValueError("accepted_release_invalid_host_identity")
        with self.locked():
            if self.manifest() is not None or self.legacy() is not None:
                raise ValueError("accepted_release_already_designated_or_accepted")
            if regular_file_exists(self.designation_path):
                if read_json(self.designation_path) != expected:
                    raise ValueError("accepted_release_designation_mismatch")
            else:
                atomic_write(self.designation_path, json.dumps(expected, sort_keys=True) + "\n")
        return {"designated": True}

    def preflight(self, bootstrap=False, public_ip=None, identity=None):
        release = self.manifest()
        try:
            legacy = self.legacy()
        except ValueError as error:
            if str(error) != "accepted_release_legacy_invalid":
                raise
            if release is not None:
                raise ValueError("accepted_release_legacy_repair_required") from None
            raise ValueError("accepted_release_legacy_without_manifest") from None
        if release is not None:
            if legacy != release["imageSha"]:
                raise ValueError("accepted_release_legacy_repair_required")
            if bootstrap:
                raise ValueError("accepted_release_bootstrap_on_accepted_host")
            return {"mode": "ordinary", "release": release}
        if legacy is not None:
            raise ValueError("accepted_release_legacy_without_manifest")
        if not bootstrap:
            raise ValueError("accepted_release_missing")
        expected = {"schemaVersion": 1, "publicIp": public_ip, "hostId": identity or host_identity(), "root": str(self.root)}
        if not regular_file_exists(self.designation_path) or read_json(self.designation_path) != expected:
            raise ValueError("accepted_release_designation_mismatch")
        return {"mode": "bootstrap", "release": None}

    def binding(self, image_sha):
        image_sha = checked_sha(image_sha)
        path = self.directory / "bindings" / f"{image_sha}.json"
        if not regular_file_exists(path):
            return None
        binding = read_json(path)
        if (not isinstance(binding, dict) or set(binding) != {"imageSha", "assetSha"}
                or binding["imageSha"] != image_sha):
            raise ValueError("accepted_release_invalid_asset_binding")
        checked_sha(binding["assetSha"])
        return binding

    def bind(self, image_sha, asset_sha):
        expected = {"imageSha": checked_sha(image_sha), "assetSha": checked_sha(asset_sha)}
        with self.locked():
            old = self.binding(image_sha)
            if old is not None and old != expected:
                raise ValueError("accepted_release_asset_binding_mismatch")
            release = self.manifest()
            if release and release["imageSha"] == image_sha and release["assetSha"] != asset_sha:
                raise ValueError("accepted_release_asset_binding_mismatch")
            if old is None:
                atomic_write(self.directory / "bindings" / f"{image_sha}.json", json.dumps(expected, sort_keys=True) + "\n")
        return expected

    def publish(self, release, proof_path, bootstrap=False, public_ip=None, identity=None):
        release = validate_release(release)
        proof = load_gate_proof(proof_path, self.root, release["imageSha"])
        if (proof["runId"], proof["runAttempt"]) != (release["runId"], release["runAttempt"]):
            raise ValueError("accepted_release_gate_run_mismatch")
        with self.locked():
            previous = self.preflight(bootstrap, public_ip, identity)["release"]
            binding = self.binding(release["imageSha"])
            if binding != {"imageSha": release["imageSha"], "assetSha": release["assetSha"]}:
                raise ValueError("accepted_release_asset_binding_required")
            snapshot = self.directory / "snapshots" / release["snapshotId"]
            try:
                metadata = snapshot.lstat()
            except FileNotFoundError:
                raise ValueError("accepted_release_snapshot_missing") from None
            if not stat.S_ISDIR(metadata.st_mode):
                raise ValueError("accepted_release_snapshot_missing")
            verify_snapshot(snapshot, release["imageSha"], release["assetSha"])
            if previous is not None and previous["imageSha"] != release["imageSha"]:
                atomic_write(self.directory / "previous-release.json", json.dumps(previous, sort_keys=True, indent=2) + "\n")
            atomic_write(self.manifest_path, json.dumps(release, sort_keys=True, indent=2) + "\n")
            try:
                atomic_write(self.legacy_path, release["imageSha"] + "\n")
            except (OSError, PublicationUnconfirmed):
                raise RuntimeError("accepted_release_legacy_repair_required") from None
        return {"published": True, "release": release}

    def repair_legacy(self):
        with self.locked():
            release = self.manifest()
            if release is None:
                raise ValueError("accepted_release_missing")
            atomic_write(self.legacy_path, release["imageSha"] + "\n")
        return {"repaired": True, "imageSha": release["imageSha"]}

    def committed(self, image_sha, run_id, run_attempt):
        checked_sha(image_sha)
        release = self.manifest()
        return {"published": bool(release and (release["imageSha"], release["runId"], release["runAttempt"])
                                  == (image_sha, run_id, run_attempt)), "release": release}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["read", "designate", "bind-assets", "asset-binding", "publish", "repair-legacy", "committed"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--state-dir")
    parser.add_argument("--bootstrap", action="store_true")
    parser.add_argument("--public-ip")
    parser.add_argument("--image-sha")
    parser.add_argument("--asset-sha")
    parser.add_argument("--record")
    parser.add_argument("--gate-proof")
    parser.add_argument("--run-id")
    parser.add_argument("--run-attempt", type=int)
    args = parser.parse_args()
    state = AcceptedState(args.root, args.state_dir)
    if args.command == "read":
        with state.locked(create=False, shared=True):
            result = state.preflight(args.bootstrap, args.public_ip)
    elif args.command == "designate":
        result = state.designate(args.public_ip)
    elif args.command == "bind-assets":
        result = state.bind(args.image_sha, args.asset_sha)
    elif args.command == "asset-binding":
        result = {"binding": state.binding(args.image_sha)}
    elif args.command == "publish":
        if not args.record or not args.gate_proof:
            raise ValueError("accepted_release_publication_inputs_required")
        result = state.publish(read_json(args.record), args.gate_proof, args.bootstrap, args.public_ip)
    elif args.command == "repair-legacy":
        result = state.repair_legacy()
    else:
        if not args.run_id or args.run_attempt is None:
            raise ValueError("accepted_release_commit_inputs_required")
        with state.locked(create=False, shared=True):
            result = state.committed(args.image_sha, args.run_id, args.run_attempt)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        message = str(error)
        if not message.startswith(("accepted_release_", "staging_gate_proof_", "staging_json_")):
            message = "accepted_release_operation_failed"
        raise SystemExit(message) from None
