#!/usr/bin/env python3
"""Focused stdlib tests; fake aws executable, never live S3 credentials or assets."""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HELPER = Path(__file__).with_name("private-scene-release.py")
spec = importlib.util.spec_from_file_location("private_scene_release", HELPER)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

FAKE_AWS = r'''#!/usr/bin/env python3
import base64, hashlib, json, os, pathlib, sys
args = sys.argv[1:]
def arg(name):
    return args[args.index(name) + 1]
operation = args[args.index("s3api") + 1]
key = arg("--key")
root = pathlib.Path(os.environ["FAKE_S3"])
target = root / "objects" / key
mode = os.environ.get("FAKE_MODE", "")
event = {"operation": operation, "key": key, "args": args,
         "config": pathlib.Path(os.environ["AWS_CONFIG_FILE"]).read_text(),
         "credentialsPresent": bool(os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY")),
         "profilesAbsent": "AWS_PROFILE" not in os.environ and "AWS_DEFAULT_PROFILE" not in os.environ,
         "metadataDisabled": os.environ.get("AWS_EC2_METADATA_DISABLED"),
         "sharedCredentialsFile": os.environ.get("AWS_SHARED_CREDENTIALS_FILE")}
with (root / "events.jsonl").open("a") as stream:
    stream.write(json.dumps(event) + "\n")
def error(code):
    print("An error occurred (" + code + ") when calling the Operation operation: " +
          os.environ.get("AWS_SECRET_ACCESS_KEY", ""), file=sys.stderr)
    sys.exit(1)
if mode == "denied":
    error("AccessDenied")
if mode == "invalid_response":
    print("not-json")
    sys.exit(0)
if operation == "head-object":
    if not target.exists():
        error("403" if mode == "hidden_missing" else "404")
    print(json.dumps({"ContentLength": target.stat().st_size, "ETag": "not-a-digest-multipart-13"}))
elif operation == "get-object":
    if not target.exists():
        error("NoSuchKey")
    pathlib.Path(args[-1]).write_bytes(target.read_bytes())
    if mode == "bad_readback":
        pathlib.Path(args[-1]).write_bytes(b"x" * target.stat().st_size)
    print(json.dumps({"ContentLength": target.stat().st_size}))
elif operation == "put-object":
    if mode == "unsupported":
        error("NotImplemented")
    if mode == "fail_archive" and key.endswith("bundle.tar.gz"):
        error("AccessDenied")
    assert arg("--if-none-match") == "*", "unconditional write forbidden"
    body = pathlib.Path(arg("--body")).read_bytes()
    assert base64.b64decode(arg("--content-md5")) == hashlib.md5(body).digest()
    target.parent.mkdir(parents=True, exist_ok=True)
    if mode.startswith("race_") and not target.exists():
        target.write_bytes(body if mode == "race_match" else b"x" * len(body))
    try:
        with target.open("xb") as stream:
            stream.write(body)
    except FileExistsError:
        error("PreconditionFailed")
    print(json.dumps({"ETag": "not-a-digest-multipart-13"}))
else:
    raise AssertionError("unexpected operation: " + operation)
'''


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="private-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "fixture")
        self.git("config", "core.filemode", "true")
        scene = self.source / "assets/scenes/test-scene"
        scene.mkdir(parents=True)
        (self.source / "assets/manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "scenesRoot": "scenes",
            "scenes": [{"sceneId": "test-scene", "sceneDir": "test-scene"}],
        }))
        (scene / "scene.json").write_text('{"sceneId":"test-scene","glbPath":"scene.glb"}\n')
        (scene / "scene.glb").write_bytes(bytes(range(256)) * 4)
        (self.source / "RECOVERY.md").write_text("not in archive\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.bin / "aws").write_text(FAKE_AWS)
        (self.bin / "aws").chmod(0o700)
        self.remote = self.root / "s3"
        self.remote.mkdir()
        self.env = {
            "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_S3": str(self.remote),
            "AWS_ACCESS_KEY_ID": "fixture-access-never-log",
            "AWS_SECRET_ACCESS_KEY": "fixture-secret-never-log",
            "AWS_PROFILE": "must-not-use", "AWS_DEFAULT_PROFILE": "must-not-use",
            "AWS_ROLE_ARN": "must-not-use", "AWS_ENDPOINT_URL": "http://must-not-use",
        }
        self.environment = patch.dict(os.environ, self.env)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.source), *args], stderr=subprocess.PIPE).decode()

    def packed(self):
        target = self.root / "package"
        descriptor = release.pack(self.source, self.sha, target)
        return target, descriptor

    def storage(self):
        return release.S3("https://s3.example.invalid", "region-1", "private-bucket", timeout=10)

    def events(self):
        path = self.remote / "events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def puts(self):
        return [event["key"] for event in self.events() if event["operation"] == "put-object"]

    def remote_path(self, key):
        return self.remote / "objects" / key

    def cli(self, *args, **kwargs):
        return subprocess.run([sys.executable, str(HELPER), *map(str, args)],
                              capture_output=True, text=True, **kwargs)

    def test_deterministic_archive_inventory_and_unchanged_source_bytes(self):
        before, scenes = release.source_inventory(self.source, self.sha)
        first, descriptor = self.packed()
        for file in (self.source / "assets").rglob("*"):
            if file.is_file():
                os.utime(file, (1700000000, 1700000000))
                file.chmod(0o755)
        second = self.root / "second"
        self.assertEqual(descriptor, release.pack(self.source, self.sha, second))
        for name in ("bundle.tar.gz", "inventory.json", "release.json"):
            self.assertEqual((first / name).read_bytes(), (second / name).read_bytes())
            self.assertEqual(stat.S_IMODE((first / name).stat().st_mode), 0o600)
        self.assertEqual((before, scenes), release.source_inventory(self.source, self.sha))
        with tarfile.open(first / "bundle.tar.gz", "r:gz") as archive:
            self.assertEqual(archive.getnames(), [e["path"] for e in before["files"]] + ["inventory.json"])
            for entry in archive:
                self.assertTrue(entry.isfile())
                self.assertEqual((entry.uid, entry.gid, entry.mtime, entry.mode), (0, 0, 0, 0o644))
                expected = (first / entry.name) if entry.name == "inventory.json" else (self.source / entry.name)
                self.assertEqual(archive.extractfile(entry).read(), expected.read_bytes())
        self.assertEqual(len(descriptor["assetSha"]), 40)
        self.assertEqual(len(descriptor["archive"]["sha256"]), 64)
        self.assertEqual(self.git("status", "--porcelain"), " M assets/manifest.json\n M assets/scenes/test-scene/scene.glb\n M assets/scenes/test-scene/scene.json\n")

    def test_pack_rejects_dirty_missing_and_extra_assets(self):
        path = self.source / "assets/scenes/test-scene/scene.glb"
        original = path.read_bytes()
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "source_bytes_differ"):
            self.packed()
        path.unlink()
        with self.assertRaisesRegex(ValueError, "source_assets_incomplete"):
            self.packed()
        path.write_bytes(original)
        (path.parent / "secret.env").write_text("not allowed")
        with self.assertRaisesRegex(ValueError, "source_untracked_asset"):
            self.packed()
        self.assertFalse((self.root / "package").exists())

    def test_pack_rejects_links_and_special_files(self):
        path = self.source / "assets/scenes/test-scene/scene.glb"
        path.unlink()
        path.symlink_to(self.source / "RECOVERY.md")
        with self.assertRaisesRegex(ValueError, "source_not_regular"):
            self.packed()
        path.unlink()
        os.mkfifo(path)
        with self.assertRaisesRegex(ValueError, "source_not_regular"):
            self.packed()

    def test_output_no_clobber_and_outside_source(self):
        target, _ = self.packed()
        before = (target / "release.json").read_bytes()
        with self.assertRaises(FileExistsError):
            release.pack(self.source, self.sha, target)
        self.assertEqual(before, (target / "release.json").read_bytes())
        with self.assertRaisesRegex(ValueError, "output_inside_source"):
            release.pack(self.source, self.sha, self.source / "output")

    def test_wrong_source_identity_and_sha_are_rejected(self):
        for sha in ("main", "a" * 64, "A" * 40, "../release", "b" * 40):
            with self.subTest(sha=sha), self.assertRaises(ValueError):
                release.pack(self.source, sha, self.root / "package")

    def test_source_manifest_catalog_must_be_complete(self):
        path = self.source / "assets/manifest.json"
        path.write_text('{"schemaVersion":1,"scenesRoot":"scenes","scenes":[]}')
        self.git("add", ".")
        self.git("commit", "-qm", "invalid catalog")
        with self.assertRaisesRegex(ValueError, "source_catalog_mismatch"):
            release.pack(self.source, self.git("rev-parse", "HEAD").strip(), self.root / "package")

    def test_pack_cleans_own_output_if_source_changes_during_write(self):
        original = release.tar_entry

        def changing(*args):
            original(*args)
            (self.source / "assets/scenes/test-scene/scene.glb").write_bytes(b"x" * 1024)

        with patch.object(release, "tar_entry", changing), self.assertRaises(ValueError):
            self.packed()
        self.assertFalse((self.root / "package").exists())

    def test_strict_descriptor_schema_and_key_derivation(self):
        _, record = self.packed()
        mutations = [
            lambda d: d.update(assetSha="a" * 64),
            lambda d: d.update(schemaVersion=True),
            lambda d: d.update(unexpected="credential"),
            lambda d: d["archive"].update(key="https://secret@wrong/bundle"),
            lambda d: d["archive"].update(sha256="a" * 40),
            lambda d: d["archive"].update(bytes=True),
            lambda d: d["inventory"].update(sha256="x" * 64),
            lambda d: d["inventory"].update(fileCount=0),
            lambda d: d["provenance"].update(sourceCommit="b" * 40),
            lambda d: d.update(scenes=["test-scene", "test-scene"]),
            lambda d: d.update(scenes=["../escape"]),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(record)
            mutate(changed)
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                release.validate_descriptor(changed)

    def test_strict_inventory_paths_order_sizes_and_duplicate_json(self):
        record, _ = release.source_inventory(self.source, self.sha)
        for path in ("/etc/passwd", "../file", "assets/../scene", "assets//scenes/file",
                     "assets/scenes/./file", "assets/scenes/evil\\file", "assets/.git/config",
                     "key.env", "assets/scenes/new\nline"):
            changed = copy.deepcopy(record)
            changed["files"][0]["path"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                release.validate_inventory(changed)
        changed = copy.deepcopy(record)
        changed["files"] += changed["files"][:1]
        with self.assertRaises(ValueError):
            release.validate_inventory(changed)
        path = self.root / "duplicate.json"
        path.write_text('{"schemaVersion":1,"schemaVersion":2}')
        with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
            release.read_json(path)

    def test_publish_order_conditional_put_and_idempotence(self):
        package, descriptor = self.packed()
        release.publish(package, self.storage())
        self.assertEqual(self.puts(), [descriptor["archive"]["key"], release.descriptor_key(self.sha)])
        for key, name in ((descriptor["archive"]["key"], "bundle.tar.gz"),
                          (release.descriptor_key(self.sha), "release.json")):
            self.assertEqual(self.remote_path(key).read_bytes(), (package / name).read_bytes())
        count = len(self.puts())
        release.publish(package, self.storage())
        self.assertEqual(count, len(self.puts()))
        first_descriptor_put = next(i for i, e in enumerate(self.events())
                                    if e["operation"] == "put-object" and e["key"].endswith("release.json"))
        self.assertTrue(any(e["operation"] == "get-object" and e["key"].endswith("bundle.tar.gz")
                            for e in self.events()[:first_descriptor_put]))

    def test_credentials_config_and_timeouts_never_enter_command_or_log(self):
        package, _ = self.packed()
        result = self.cli("publish", "--package", package, "--endpoint", "https://s3.example.invalid",
                          "--region", "region-1", "--bucket", "private-bucket", "--timeout", "10")
        self.assertEqual(result.returncode, 0, result.stderr)
        for event in self.events():
            self.assertTrue(event["credentialsPresent"] and event["profilesAbsent"])
            self.assertEqual(event["metadataDisabled"], "true")
            self.assertEqual(event["sharedCredentialsFile"], os.devnull)
            self.assertIn("addressing_style = virtual", event["config"])
            self.assertIn("--cli-connect-timeout", event["args"])
            self.assertIn("--cli-read-timeout", event["args"])
            for secret in (self.env["AWS_ACCESS_KEY_ID"], self.env["AWS_SECRET_ACCESS_KEY"]):
                self.assertNotIn(secret, json.dumps(event) + result.stdout + result.stderr)

    def test_existing_descriptor_conflict_stops_before_archive_upload(self):
        package, _ = self.packed()
        target = self.remote_path(release.descriptor_key(self.sha))
        target.parent.mkdir(parents=True)
        target.write_bytes(b"conflicting descriptor")
        with self.assertRaisesRegex(ValueError, "release_conflict"):
            release.publish(package, self.storage())
        self.assertEqual(self.puts(), [])

    def test_same_length_conflicting_archive_is_detected_without_etag(self):
        package, descriptor = self.packed()
        target = self.remote_path(descriptor["archive"]["key"])
        target.parent.mkdir(parents=True)
        target.write_bytes(b"x" * descriptor["archive"]["bytes"])
        with self.assertRaisesRegex(ValueError, "release_conflict"):
            release.publish(package, self.storage())
        self.assertEqual(self.puts(), [])

    def test_racing_identical_publication_is_verified(self):
        package, _ = self.packed()
        with patch.dict(os.environ, {"FAKE_MODE": "race_match"}):
            release.publish(package, self.storage())
        self.assertEqual(len(self.puts()), 2)

    def test_racing_different_publication_does_not_clobber(self):
        package, descriptor = self.packed()
        with patch.dict(os.environ, {"FAKE_MODE": "race_conflict"}), self.assertRaisesRegex(ValueError, "release_conflict"):
            release.publish(package, self.storage())
        self.assertFalse(self.remote_path(release.descriptor_key(self.sha)).exists())
        self.assertEqual(self.remote_path(descriptor["archive"]["key"]).read_bytes(),
                         b"x" * descriptor["archive"]["bytes"])

    def test_no_unconditional_fallback_when_conditional_put_is_unsupported(self):
        package, _ = self.packed()
        with patch.dict(os.environ, {"FAKE_MODE": "unsupported"}), self.assertRaisesRegex(release.S3Error, "s3_NotImplemented"):
            release.publish(package, self.storage())
        self.assertEqual(len(self.puts()), 1)
        self.assertFalse((self.remote / "objects").exists())

    def test_archive_failure_never_publishes_descriptor(self):
        package, _ = self.packed()
        with patch.dict(os.environ, {"FAKE_MODE": "fail_archive"}), self.assertRaisesRegex(release.S3Error, "s3_AccessDenied"):
            release.publish(package, self.storage())
        self.assertEqual(len(self.puts()), 1)
        self.assertFalse(self.remote_path(release.descriptor_key(self.sha)).exists())

    def test_failed_archive_readback_never_publishes_descriptor(self):
        package, _ = self.packed()
        with patch.dict(os.environ, {"FAKE_MODE": "bad_readback"}), self.assertRaisesRegex(ValueError, "release_conflict"):
            release.publish(package, self.storage())
        self.assertFalse(self.remote_path(release.descriptor_key(self.sha)).exists())

    def test_403_only_allows_conditional_attempt_and_error_is_redacted(self):
        package, _ = self.packed()
        with patch.dict(os.environ, {"FAKE_MODE": "denied"}):
            result = self.cli("publish", "--package", package, "--endpoint", "https://s3.example.invalid",
                              "--region", "region-1", "--bucket", "private-bucket")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), "private_scene_release: s3_AccessDenied")
        self.assertEqual(len(self.puts()), 1)
        self.assertIn("--if-none-match", self.events()[-1]["args"])
        self.assertNotIn(self.env["AWS_SECRET_ACCESS_KEY"], result.stdout + result.stderr)

    def test_writer_without_list_permission_can_create_and_verify_release(self):
        package, _ = self.packed()
        with patch.dict(os.environ, {"FAKE_MODE": "hidden_missing"}):
            release.publish(package, self.storage())
        self.assertEqual(len(self.puts()), 2)

    def test_local_corruption_fails_before_network(self):
        package, _ = self.packed()
        (package / "bundle.tar.gz").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "archive_mismatch"):
            release.publish(package, self.storage())
        self.assertEqual(self.events(), [])

    def test_local_inventory_mismatch_fails_before_network(self):
        package, _ = self.packed()
        path = package / "inventory.json"
        inventory = json.loads(path.read_text())
        inventory["files"][0]["bytes"] += 1
        path.write_bytes(release.canonical(inventory))
        with self.assertRaisesRegex(ValueError, "inventory_mismatch"):
            release.publish(package, self.storage())
        self.assertEqual(self.events(), [])

    def test_concurrent_local_edit_does_not_poison_immutable_archive(self):
        package, descriptor = self.packed()
        expected = (package / "bundle.tar.gz").read_bytes()
        storage = self.storage()
        original = storage.existing

        def edit_original(key, path):
            (package / "bundle.tar.gz").write_bytes(b"modified after validation")
            return original(key, path)

        with patch.object(storage, "existing", edit_original):
            release.publish(package, storage)
        self.assertEqual(self.remote_path(descriptor["archive"]["key"]).read_bytes(), expected)

    def test_rejects_unsafe_endpoints_and_invalid_settings(self):
        for endpoint in ("http://insecure", "https://user:secret@host", "https://host/path",
                         "https://host?secret=1", "https://host#fragment", "file:///tmp"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                release.S3(endpoint, "region-1", "private-bucket")
        for timeout in (0, 901, True):
            with self.assertRaises(ValueError):
                release.S3("https://host", "region-1", "private-bucket", timeout=timeout)
        with patch.dict(os.environ, {"AWS_SECRET_ACCESS_KEY": ""}), self.assertRaisesRegex(ValueError, "missing_env_credentials"):
            self.storage()

    def test_subprocess_timeout_and_malformed_response_are_sanitized(self):
        storage = self.storage()
        with patch.object(release.subprocess, "run", side_effect=subprocess.TimeoutExpired("secret", 10)):
            with self.assertRaisesRegex(release.S3Error, "^s3_timeout$"):
                storage.call("head-object", "--key", release.descriptor_key(self.sha))
        with patch.dict(os.environ, {"FAKE_MODE": "invalid_response"}):
            with self.assertRaisesRegex(release.S3Error, "^s3_invalid_response$"):
                storage.call("head-object", "--key", release.descriptor_key(self.sha))
        failed = subprocess.CompletedProcess([], 255, b"", b'Could not connect to the endpoint URL: "secret"')
        with patch.object(release.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(release.S3Error, "^s3_connection_failed$"):
                storage.call("head-object", "--key", release.descriptor_key(self.sha))

    def test_lost_put_response_requires_byte_readback(self):
        package, _ = self.packed()
        storage = self.storage()
        original = storage.call

        def lost_response(operation, *args):
            result = original(operation, *args)
            if operation == "put-object":
                raise release.S3Error("s3_timeout")
            return result

        with patch.object(storage, "call", lost_response):
            release.publish(package, storage)
        self.assertTrue(self.remote_path(release.descriptor_key(self.sha)).exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
