#!/usr/bin/env python3
"""Host-side release transitions; CI owns room patching and public verification."""

import argparse
from contextlib import contextmanager
import fcntl
import ipaddress
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from staging_gate_proof import checked_sha, read_json
from staging_scene_files import activate_snapshot, prepare_snapshot, prune_snapshots


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


accepted = load("staging-accepted-release")
catalog = load("staging-template-catalog")
minio = load("staging-minio-rollout")


class ReleaseHost:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.state = accepted.AcceptedState(root)
        self.catalog = catalog.CatalogHost(root)
        self.env_path = self.root / "infra/docker/.env.staging"

    def env(self):
        values = {}
        for line in self.env_path.read_text().splitlines():
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
        return values

    @contextmanager
    def operation_lock(self):
        # SSH cancellation may leave a remote process running. Recovery waits for
        # that operation rather than racing checkout, Compose or scene selection.
        fd = os.open(self.state.directory / ".deploy.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def run(self, args, quiet=False):
        result = subprocess.run(args, cwd=self.root, stdin=subprocess.DEVNULL, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError("staging_release_command_failed:" + args[0])
        if not quiet and result.stdout:
            print(result.stdout, file=sys.stderr, end="")
        return result.stdout.strip()

    def preflight(self, image_sha, bootstrap=False):
        checked_sha(image_sha)
        values = self.env()
        ip = values.get("VRATA_STAGING_PUBLIC_IP") or values.get("LIVEKIT_NODE_IP")
        if not ip or values.get("LIVEKIT_NODE_IP") != ip:
            raise ValueError("staging_release_public_ip_required")
        try:
            ipaddress.IPv4Address(ip)
        except ValueError:
            raise ValueError("staging_release_public_ip_required") from None
        with self.state.locked(create=False, shared=True):
            previous = self.state.preflight(bootstrap, ip)
        if previous["release"] is not None:
            self.catalog.guard_accepted(previous["release"]["imageSha"])
            # A candidate must not leave recovery dependent on an image that the
            # live identity/room-record boundary already forbids rolling back to.
            self.catalog.prepare(previous["release"]["imageSha"])
        return {**previous, "binding": self.state.binding(image_sha)}

    def attempt_path(self, run_id, run_attempt):
        if not run_id.isdigit() or run_attempt < 1:
            raise ValueError("staging_release_invalid_run")
        return self.state.directory / "attempts" / f"{run_id}-{run_attempt}"

    def rollout(self, image_sha, asset_sha, source, run_id, run_attempt, bootstrap=False):
        previous = self.preflight(image_sha, bootstrap)
        attempt = self.attempt_path(run_id, run_attempt)
        accepted.atomic_write(attempt / "previous.json", json.dumps(previous["release"]) + "\n")
        self.run(["git", "-c", f"safe.directory={self.root}", "fetch", "--no-tags", "--depth=1", "origin", image_sha])
        candidate_compose = self.run(["git", "-c", f"safe.directory={self.root}", "show", f"{image_sha}:infra/docker/compose.staging.yml"], quiet=True)
        if "VRATA_STAGING_SCENE_ROOT" not in candidate_compose:
            raise ValueError("staging_release_target_protocol_unsupported")
        if bootstrap:
            try:
                schema = self.catalog.schema_state()["schema"]
            except RuntimeError as error:
                if str(error) != "template_rollout_postgres_not_running":
                    raise
                self.run(self.catalog.compose + ["up", "-d", "--no-build", "--wait", "postgres"])
                schema = self.catalog.schema_state()["schema"]
            if schema == "initialized":
                self.catalog.prepare(image_sha)
        else:
            self.catalog.prepare(image_sha)
        self.run(["git", "-c", f"safe.directory={self.root}", "checkout", "--detach", image_sha])
        scene_catalog = read_json(self.root / "infra/docker/staging-scene-catalog.json")
        pointer_path = attempt / "scene-urls.json"
        pointer_snapshot = read_json(pointer_path) if accepted.regular_file_exists(pointer_path) else None
        prepare_snapshot(self.state, source, image_sha, asset_sha, scene_catalog, pointer_snapshot)
        activate_snapshot(self.state, image_sha, asset_sha)
        self.raw_rollout(image_sha)
        return {"rolledOut": image_sha}

    def raw_rollout(self, image_sha):
        env = {**os.environ, "VRATA_STAGING_APP_DIR": str(self.root),
               "VRATA_STAGING_PUBLIC_IP": self.env()["LIVEKIT_NODE_IP"]}
        script = Path(__file__).with_name("rollout-staging-images.sh")
        if not script.is_file():
            script = self.root / "infra/docker/rollout-staging-images.sh"
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("staging-minio-rollout.py")),
                                 str(script), checked_sha(image_sha)],
                                cwd=self.root, env=env, stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr)
        if result.returncode:
            raise RuntimeError("staging_release_rollout_failed")

    def foundation_digests(self):
        result = {}
        for service in accepted.FOUNDATIONS:
            container = self.run(self.catalog.compose + ["ps", "-a", "-q", service], quiet=True)
            if len(container.splitlines()) != 1:
                raise ValueError("staging_release_foundation_missing")
            result[service] = self.run(["docker", "inspect", "--format", "{{.Config.Image}}", container], quiet=True)
        return result

    def publish(self, image_sha, asset_sha, proof_path, run_id, run_attempt, bootstrap=False):
        expected_snapshot = f"snapshots/{checked_sha(image_sha)}-{checked_sha(asset_sha)}"
        if (self.state.directory / "active").readlink().as_posix() != expected_snapshot:
            raise ValueError("staging_release_active_snapshot_mismatch")
        self.running_images(image_sha)
        self.catalog.verify_wave2(image_sha, proof_path)
        record = {"schemaVersion": 1, "imageSha": image_sha, "assetSha": asset_sha,
                  "snapshotId": f"{image_sha}-{asset_sha}", "foundationDigests": self.foundation_digests(),
                  "runId": run_id, "runAttempt": run_attempt}
        self.state.publish(record, proof_path, bootstrap, self.env()["LIVEKIT_NODE_IP"])
        self.catalog.record_wave2(image_sha, proof_path)
        return {"published": image_sha}

    def running_images(self, image_sha):
        values = self.env()
        for service, repository in (("api", "API_IMAGE_REPO"), ("room-state", "ROOM_STATE_IMAGE_REPO"),
                                    ("remote-browser", "REMOTE_BROWSER_IMAGE_REPO")):
            container = self.run(self.catalog.compose + ["ps", "-q", service], quiet=True)
            if len(container.splitlines()) != 1:
                raise ValueError("staging_release_runtime_missing")
            image = self.run(["docker", "inspect", "--format", "{{.Config.Image}}", container], quiet=True)
            if image != f'{values.get(repository)}:{image_sha}':
                raise ValueError("staging_release_runtime_image_mismatch")

    def activate_identity_v2(self, image_sha):
        """Irreversible: raise the identity protocol floor to 2 for the rolled-out candidate.

        Both the candidate and the accepted release that an automatic rollback would restore
        must already satisfy every floor-2 capability, because the floor is never lowered."""
        checked_sha(image_sha)
        self.running_images(image_sha)
        with self.state.locked(create=False, shared=True):
            previous = self.state.manifest()
        try:
            catalog.assert_target_allowed(None, None, self.catalog.contract(image_sha), image_sha, 2, True, True)
        except ValueError as error:
            raise ValueError("staging_identity_activation_candidate_incompatible:" + str(error)) from None
        if previous is not None:
            try:
                catalog.assert_target_allowed(None, None, self.catalog.contract(previous["imageSha"]), previous["imageSha"], 2, True, True)
            except ValueError as error:
                raise ValueError("staging_identity_activation_rollback_target_incompatible:" + str(error)) from None
        try:
            self.catalog.validate_identity_database()
            self.catalog.validate_identity_configuration()
        except ValueError as error:
            raise ValueError("staging_identity_activation_configuration:" + str(error)) from None
        output = self.run(self.catalog.compose + ["exec", "-T", "-w", "/app", "api", "node",
                                                  "apps/api/dist/identity/activate-v2.js", "--confirm-irreversible"], quiet=True)
        try:
            result = json.loads(output.splitlines()[-1])
        except (IndexError, ValueError):
            raise RuntimeError("staging_identity_activation_unconfirmed") from None
        if result.get("ok") is not True or result.get("after") != 2:
            raise RuntimeError("staging_identity_activation_unconfirmed")
        if self.catalog.minimum_identity_protocol() != 2:
            raise RuntimeError("staging_identity_activation_unconfirmed")
        return {"identityProtocol": {"before": result["before"], "after": 2, "raised": result["raised"], "audit": result["audit"]},
                "rollbackTarget": previous["imageSha"] if previous else None}

    def rollback(self, image_sha, run_id, run_attempt):
        result = self.state.committed(image_sha, run_id, run_attempt)
        if result["published"]:
            raise RuntimeError("staging_release_committed_metadata_repair_required")
        previous_path = self.attempt_path(run_id, run_attempt) / "previous.json"
        if not accepted.regular_file_exists(previous_path):
            return {"rollback": "not_started"}
        previous = read_json(previous_path)
        if previous is None:
            return {"rollback": "no_previous_release", "bootstrap": True}
        previous = accepted.validate_release(previous)
        current = self.state.manifest()
        if current != previous:
            raise ValueError("staging_release_previous_state_changed")
        target = previous["imageSha"]
        self.catalog.prepare(target)
        self.run(["git", "-c", f"safe.directory={self.root}", "checkout", "--detach", target])
        activate_snapshot(self.state, target, previous["assetSha"])
        self.raw_rollout(target)
        return {"rollback": "restored", "imageSha": target, "assetSha": previous["assetSha"]}

    def prune(self, image_sha):
        release = self.preflight(image_sha)["release"]
        if release["imageSha"] != image_sha:
            raise ValueError("staging_release_cleanup_image_mismatch")
        return prune_snapshots(self.state)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["preflight", "rollout", "publish", "rollback", "prune", "committed", "activate-identity-v2"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--image-sha", required=True)
    parser.add_argument("--asset-sha")
    parser.add_argument("--source")
    parser.add_argument("--gate-proof")
    parser.add_argument("--run-id")
    parser.add_argument("--run-attempt", type=int, default=1)
    parser.add_argument("--bootstrap", action="store_true")
    args = parser.parse_args()
    host = ReleaseHost(args.root)
    checked_sha(args.image_sha)
    if args.command == "preflight":
        result = host.preflight(args.image_sha, args.bootstrap)
    elif args.command in ("rollout", "publish", "rollback", "prune", "activate-identity-v2"):
        with host.operation_lock():
            if args.command == "activate-identity-v2":
                result = host.activate_identity_v2(args.image_sha)
            elif args.command == "rollout":
                result = host.rollout(args.image_sha, checked_sha(args.asset_sha), args.source, args.run_id, args.run_attempt, args.bootstrap)
            elif args.command == "publish":
                result = host.publish(args.image_sha, checked_sha(args.asset_sha), args.gate_proof, args.run_id, args.run_attempt, args.bootstrap)
            elif args.command == "prune":
                result = host.prune(args.image_sha)
            else:
                result = host.rollback(args.image_sha, args.run_id, args.run_attempt)
    else:
        result = host.state.committed(args.image_sha, args.run_id, args.run_attempt)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        message = str(error)
        if not message.startswith(("staging_", "accepted_", "template_")):
            message = "staging_release_operation_failed"
        raise SystemExit(message) from None
