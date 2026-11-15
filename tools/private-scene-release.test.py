#!/usr/bin/env python3
"""Focused stdlib tests; fake aws executable, never live S3 credentials or assets."""

import copy
import gzip
import hashlib
import importlib.util
import io
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
import base64, hashlib, json, os, pathlib, shutil, sys
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
    if mode == "interrupted_archive" and key.endswith("bundle.tar.gz"):
        pathlib.Path(args[-1]).write_bytes(b"partial")
        error("AccessDenied")
    if "--range" in args:
        assert arg("--range") == "bytes=0-" + str(target.stat().st_size)
    shutil.copyfile(target, args[-1])
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
        self.catalog = self.root / "catalog.json"
        self.catalog.write_bytes(release.canonical({
            "schemaVersion": 1, "rooms": [{"sceneId": "test-scene"}],
        }))
        self.output = self.root / "fetched"

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

    def install(self, package):
        record = json.loads((package / "release.json").read_text())
        for key, name in ((release.descriptor_key(record["assetSha"]), "release.json"),
                          (record["archive"]["key"], "bundle.tar.gz")):
            target = self.remote_path(key)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((package / name).read_bytes())
        return record

    def fetch(self, sha=None, lock=None, catalog=None):
        return release.fetch(self.output, self.storage(), None if lock else (sha or self.sha),
                             lock, catalog or self.catalog)

    def lock_file(self, package, record):
        size, digest = release.digest_file(package / "release.json")
        path = self.root / "release.lock.json"
        path.write_bytes(release.canonical({
            "schemaVersion": 1, "assetSha": record["assetSha"],
            "descriptor": {"key": release.descriptor_key(record["assetSha"]), "bytes": size, "sha256": digest},
            "archive": record["archive"], "inventory": record["inventory"],
        }))
        return path

    def rewrite_archive(self, package, change):
        with tarfile.open(package / "bundle.tar.gz", "r:gz") as archive:
            members = [(copy.copy(member), archive.extractfile(member).read()) for member in archive]
        members = change(members)
        with tarfile.open(package / "bundle.tar.gz", "w:gz", format=tarfile.USTAR_FORMAT) as archive:
            for member, data in members:
                archive.addfile(member, io.BytesIO(data))
        record = json.loads((package / "release.json").read_text())
        size, digest = release.digest_file(package / "bundle.tar.gz")
        record["archive"] = {"key": release.archive_key(record["assetSha"], digest), "bytes": size, "sha256": digest}
        (package / "release.json").write_bytes(release.canonical(record))
        return record

    def assert_no_source(self):
        self.assertFalse(os.path.lexists(self.output))
        self.assertEqual(list(self.root.glob(".private-scene-fetch-*")), [])

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

    def test_fetch_lock_on_machine_without_scene_git_or_helper_dependencies(self):
        package, descriptor = self.packed()
        self.install(package)
        lock = self.lock_file(package, descriptor)
        runner = self.root / "runner"
        runner.mkdir()
        helper = runner / HELPER.name
        helper.write_bytes(HELPER.read_bytes())
        (self.bin / "git").write_text("#!/bin/sh\nexit 99\n")
        (self.bin / "git").chmod(0o700)
        result = subprocess.run([
            sys.executable, str(helper), "fetch", "--lock", str(lock),
            "--catalog", str(self.catalog), "--output", str(self.output),
            "--endpoint", "https://s3.example.invalid", "--region", "region-1",
            "--bucket", "private-bucket", "--timeout", "10", "--addressing-style", "path",
        ], cwd=runner, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["assetSha"], self.sha)
        self.assertEqual((self.output / "assets/scenes/test-scene/scene.glb").read_bytes(),
                         (self.source / "assets/scenes/test-scene/scene.glb").read_bytes())
        self.assertFalse((runner / ".git").exists())
        self.assertFalse((self.output / ".git").exists())
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.output / "assets/manifest.json").stat().st_mode), 0o600)
        self.assertEqual(self.puts(), [])
        self.assertEqual({e["key"] for e in self.events()},
                         {release.descriptor_key(self.sha), descriptor["archive"]["key"]})

    def test_fetch_exact_binding_403_404_never_falls_back_or_leaks_secrets(self):
        package, _ = self.packed()
        self.install(package)
        for mode, sha, expected in (("denied", self.sha, "s3_AccessDenied"),
                                    ("", "b" * 40, "s3_404")):
            with self.subTest(mode=mode), patch.dict(os.environ, {"FAKE_MODE": mode}):
                result = self.cli("fetch", "--asset-sha", sha, "--catalog", self.catalog,
                                  "--output", self.output, "--endpoint", "https://s3.example.invalid",
                                  "--region", "region-1", "--bucket", "private-bucket")
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr.strip(), "private_scene_release: " + expected)
                self.assertNotIn(self.env["AWS_SECRET_ACCESS_KEY"], result.stdout + result.stderr)
                self.assert_no_source()
        self.assertEqual([e["operation"] for e in self.events()], ["head-object", "head-object"])
        self.assertEqual(self.events()[-1]["key"], release.descriptor_key("b" * 40))

    def test_fetch_descriptor_identity_schema_key_and_noncanonical_bytes(self):
        package, record = self.packed()
        self.install(package)
        path = self.remote_path(release.descriptor_key(self.sha))
        changes = [
            lambda r: r.update(assetSha="b" * 40, provenance={"sourceCommit": "b" * 40, "assetsTree": "c" * 40},
                               archive={**r["archive"], "key": release.archive_key("b" * 40, r["archive"]["sha256"])}),
            lambda r: r.update(unknown="secret"),
            lambda r: r["archive"].update(key="https://user:secret@elsewhere"),
            lambda r: r.update(schemaVersion=True),
        ]
        for change in changes:
            mutated = copy.deepcopy(record)
            change(mutated)
            path.write_bytes(release.canonical(mutated))
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.fetch()
            self.assert_no_source()
        path.write_text(json.dumps(record, indent=2))
        with self.assertRaisesRegex(ValueError, "noncanonical_descriptor"):
            self.fetch()
        path.write_text('{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
            self.fetch()
        self.assert_no_source()
        self.assertFalse(any(e["key"].endswith("bundle.tar.gz") for e in self.events()))

    def test_fetch_strict_lock_and_matching_descriptor_required(self):
        package, record = self.packed()
        self.install(package)
        path = self.lock_file(package, record)
        original = json.loads(path.read_text())
        changes = [
            lambda r: r.update(schemaVersion=True),
            lambda r: r.update(endpoint="https://secret@host"),
            lambda r: r.update(assetSha="latest"),
            lambda r: r["descriptor"].update(key="private-scenes/releases/latest/release.json"),
            lambda r: r["archive"].update(key="arbitrary"),
            lambda r: r["descriptor"].update(bytes=True),
            lambda r: r["descriptor"].update(sha256="bad"),
            lambda r: r["descriptor"].update(sha256="b" * 64),
            lambda r: r["descriptor"].update(bytes=r["descriptor"]["bytes"] + 1),
            lambda r: r["inventory"].update(totalBytes=r["inventory"]["totalBytes"] + 1),
            lambda r: r["archive"].update(bytes=r["archive"]["bytes"] + 1),
        ]
        for change in changes:
            mutated = copy.deepcopy(original)
            change(mutated)
            path.write_bytes(release.canonical(mutated))
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.fetch(lock=path)
            self.assert_no_source()
        with self.assertRaisesRegex(ValueError, "exactly_one_release_identity"):
            release.fetch(self.output, self.storage(), self.sha, path, self.catalog)

    def test_fetch_size_and_digest_verified_before_any_extraction(self):
        package, record = self.packed()
        self.install(package)
        archive = self.remote_path(record["archive"]["key"])
        original = archive.read_bytes()
        for data in (original[:-1], original + b"x", b"x" * len(original)):
            archive.write_bytes(data)
            with self.subTest(size=len(data)), patch.object(release, "unpack_archive") as unpack:
                with self.assertRaisesRegex(ValueError, "download_(size|digest)_mismatch"):
                    self.fetch()
                unpack.assert_not_called()
            self.assert_no_source()

    def test_fetch_interruption_and_timeout_cleanup_partial_files(self):
        package, _ = self.packed()
        self.install(package)
        with patch.dict(os.environ, {"FAKE_MODE": "interrupted_archive"}):
            with self.assertRaisesRegex(release.S3Error, "s3_AccessDenied"):
                self.fetch()
        self.assert_no_source()
        original = release.S3.call

        def timeout(storage, operation, *args):
            if operation == "get-object" and str(args[-1]).endswith("bundle.tar.gz"):
                Path(args[-1]).write_bytes(b"partial")
                raise release.S3Error("s3_timeout")
            return original(storage, operation, *args)

        with patch.object(release.S3, "call", timeout), self.assertRaisesRegex(release.S3Error, "s3_timeout"):
            self.fetch()
        self.assert_no_source()
        with patch.object(release, "unpack_archive", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.fetch()
        self.assert_no_source()

    def test_fetch_missing_archive_does_not_leave_source(self):
        package, record = self.packed()
        self.install(package)
        self.remote_path(record["archive"]["key"]).unlink()
        with self.assertRaisesRegex(release.S3Error, "s3_404"):
            self.fetch()
        self.assert_no_source()

    def test_fetch_idempotent_same_source_and_conflicting_identity_never_replaced(self):
        package, record = self.packed()
        self.install(package)
        self.fetch()
        before = self.output.stat().st_ino
        self.assertEqual(self.fetch(), record)
        self.assertEqual(before, self.output.stat().st_ino)
        self.git("commit", "--allow-empty", "-qm", "different identity same bytes")
        new_sha = self.git("rev-parse", "HEAD").strip()
        second = self.root / "second"
        release.pack(self.source, new_sha, second)
        self.install(second)
        with self.assertRaisesRegex(ValueError, "release_conflict"):
            self.fetch(sha=new_sha)
        self.assertEqual(json.loads((self.output / "release.json").read_text()), record)
        self.assertEqual(before, self.output.stat().st_ino)

    def test_fetch_rejects_changed_remote_release_under_same_identity(self):
        package, original = self.packed()
        self.install(package)
        self.fetch()
        changed = copy.deepcopy(original)
        changed["provenance"]["assetsTree"] = "b" * 40
        (package / "release.json").write_bytes(release.canonical(changed))
        self.install(package)
        with self.assertRaisesRegex(ValueError, "release_conflict"):
            self.fetch()
        self.assertEqual(json.loads((self.output / "release.json").read_text()), original)

    def test_fetch_rechecks_existing_source_files_and_links_without_repair(self):
        package, _ = self.packed()
        self.install(package)
        self.fetch()
        path = self.output / "assets/scenes/test-scene/scene.glb"
        path.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "source_inventory_mismatch"):
            self.fetch()
        self.assertEqual(path.read_bytes(), b"tampered")
        path.unlink()
        path.symlink_to(self.source / "RECOVERY.md")
        with self.assertRaisesRegex(ValueError, "source_not_regular"):
            self.fetch()
        path.unlink()
        os.link(self.source / "assets/scenes/test-scene/scene.glb", path)
        with self.assertRaisesRegex(ValueError, "source_not_regular"):
            self.fetch()
        path.unlink()
        path.write_bytes((self.source / "assets/scenes/test-scene/scene.glb").read_bytes())
        (self.output / "empty-evil-directory").mkdir()
        with self.assertRaisesRegex(ValueError, "source_inventory_mismatch"):
            self.fetch()

    def test_fetch_rejects_existing_empty_directory_or_symlink(self):
        package, _ = self.packed()
        self.install(package)
        self.output.mkdir()
        with self.assertRaises(OSError):
            self.fetch()
        self.assertEqual(list(self.output.iterdir()), [])
        self.output.rmdir()
        self.output.symlink_to(self.source, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "destination_not_directory"):
            self.fetch()
        self.assertTrue(self.output.is_symlink())

    def test_fetch_historical_identity_has_no_git_and_never_selects_new_snapshot(self):
        old_sha = self.sha
        old, old_record = self.packed()
        self.install(old)
        path = self.source / "assets/scenes/test-scene/scene.glb"
        path.write_bytes(b"new version")
        self.git("add", ".")
        self.git("commit", "-qm", "new")
        self.sha = self.git("rev-parse", "HEAD").strip()
        newer = self.root / "newer"
        newer_record = release.pack(self.source, self.sha, newer)
        self.install(newer)
        self.assertNotEqual(newer_record["archive"], old_record["archive"])
        self.fetch(sha=old_sha)
        self.assertEqual((self.output / "assets/scenes/test-scene/scene.glb").read_bytes(),
                         bytes(range(256)) * 4)
        self.assertEqual({e["key"] for e in self.events()},
                         {release.descriptor_key(old_sha), old_record["archive"]["key"]})

    def test_fetch_rejects_malicious_paths_duplicate_links_directories_and_special_types(self):
        package, _ = self.packed()
        original = (package / "bundle.tar.gz").read_bytes()
        descriptor = (package / "release.json").read_bytes()
        cases = [("/escape", tarfile.REGTYPE), ("../escape", tarfile.REGTYPE),
                 ("./assets/manifest.json", tarfile.REGTYPE), ("assets/../escape", tarfile.REGTYPE),
                 ("assets//scenes/test-scene/file", tarfile.REGTYPE),
                 ("assets/scenes/test-scene/./file", tarfile.REGTYPE),
                 ("assets/scenes/test-scene/evil\\file", tarfile.REGTYPE),
                 ("assets/scenes/test-scene/.git/config", tarfile.REGTYPE),
                 ("assets/scenes/test-scene/dup", tarfile.SYMTYPE),
                 ("assets/scenes/test-scene/dup", tarfile.LNKTYPE),
                 ("assets/scenes/test-scene/dup", tarfile.FIFOTYPE),
                 ("assets/scenes/test-scene/dup", tarfile.CHRTYPE),
                 ("assets/scenes/test-scene/dup", tarfile.BLKTYPE),
                 ("assets/scenes/test-scene", tarfile.DIRTYPE),
                 ("inventory.json", tarfile.DIRTYPE),
                 ("assets/scenes/test-scene/dup", tarfile.XHDTYPE),
                 ("assets/scenes/test-scene/dup", tarfile.GNUTYPE_SPARSE),
                 ("assets/scenes/test-scene/dup", tarfile.GNUTYPE_LONGNAME)]
        for name, kind in cases:
            (package / "bundle.tar.gz").write_bytes(original)
            (package / "release.json").write_bytes(descriptor)

            def change(members):
                member = tarfile.TarInfo(name)
                member.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    member.linkname = "/etc/passwd"
                return [(member, b"")] + members

            self.rewrite_archive(package, change)
            self.install(package)
            with self.subTest(name=name, kind=kind), self.assertRaises((ValueError, OSError, tarfile.TarError)):
                self.fetch()
            self.assert_no_source()
        (package / "bundle.tar.gz").write_bytes(original)
        (package / "release.json").write_bytes(descriptor)
        self.rewrite_archive(package, lambda members: members + [members[0]])
        self.install(package)
        with self.assertRaisesRegex(ValueError, "archive_duplicate_path"):
            self.fetch()
        self.assert_no_source()

    def test_fetch_declared_counts_sizes_and_per_file_inventory_are_enforced(self):
        package, record = self.packed()
        original_descriptor = (package / "release.json").read_bytes()
        for field, delta in (("fileCount", -1), ("fileCount", 1), ("totalBytes", -1),
                              ("totalBytes", 1), ("bytes", 1), ("sha256", "b" * 64)):
            changed = copy.deepcopy(record)
            changed["inventory"][field] = (delta if isinstance(delta, str) else changed["inventory"][field] + delta)
            (package / "release.json").write_bytes(release.canonical(changed))
            self.install(package)
            with self.subTest(field=field, delta=delta), self.assertRaises(ValueError):
                self.fetch()
            self.assert_no_source()
        # Change inventory but not file bytes. Re-pin all outer hashes to prove the
        # independent per-file comparison, not merely archive integrity checks.
        (package / "release.json").write_bytes(original_descriptor)
        inventory = json.loads((package / "inventory.json").read_text())
        inventory["files"][0]["bytes"] += 1
        inventory["files"][1]["bytes"] -= 1  # Keep the declared total unchanged.
        data = release.canonical(inventory)

        def replace_inventory(members):
            member = tarfile.TarInfo("inventory.json")
            member.size = len(data)
            return [(m, b) for m, b in members if m.name != "inventory.json"] + [(member, data)]

        self.rewrite_archive(package, replace_inventory)
        changed = json.loads((package / "release.json").read_text())
        changed["inventory"].update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        (package / "release.json").write_bytes(release.canonical(changed))
        self.install(package)
        with self.assertRaisesRegex(ValueError, "source_inventory_mismatch"):
            self.fetch()
        self.assert_no_source()
        inventory["files"][0]["bytes"] -= 1
        inventory["files"][1]["bytes"] += 1
        inventory["files"][0]["sha256"] = "b" * 64
        data = release.canonical(inventory)
        self.rewrite_archive(package, replace_inventory)
        changed = json.loads((package / "release.json").read_text())
        changed["inventory"].update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        (package / "release.json").write_bytes(release.canonical(changed))
        self.install(package)
        with self.assertRaisesRegex(ValueError, "source_inventory_mismatch"):
            self.fetch()
        self.assert_no_source()
        # A regular member whose header claims more than the complete declared
        # uncompressed budget is rejected before any payload is written.
        (package / "release.json").write_bytes(original_descriptor)
        huge = tarfile.TarInfo("assets/scenes/test-scene/huge")
        huge.size = record["inventory"]["totalBytes"] + 1
        with gzip.open(package / "bundle.tar.gz", "wb") as stream:
            stream.write(huge.tobuf(format=tarfile.USTAR_FORMAT))
        size, digest = release.digest_file(package / "bundle.tar.gz")
        changed = copy.deepcopy(record)
        changed["archive"] = {"key": release.archive_key(self.sha, digest), "bytes": size, "sha256": digest}
        (package / "release.json").write_bytes(release.canonical(changed))
        self.install(package)
        with self.assertRaisesRegex(ValueError, "archive_limits_exceeded"):
            self.fetch()
        self.assert_no_source()

    def test_fetch_truncated_tar_gzip_crc_and_appended_payload_are_rejected(self):
        package, record = self.packed()
        original = (package / "bundle.tar.gz").read_bytes()
        raw = gzip.decompress(original)
        variants = [original[:-8], original[:-8] + b"\0" * 8,
                    gzip.compress(raw[:512]), original + gzip.compress(b"evil"),
                    gzip.compress(raw + b"x" * 10241)]
        for archive in variants:
            (package / "bundle.tar.gz").write_bytes(archive)
            size, digest = release.digest_file(package / "bundle.tar.gz")
            changed = copy.deepcopy(record)
            changed["archive"] = {"key": release.archive_key(self.sha, digest), "bytes": size, "sha256": digest}
            (package / "release.json").write_bytes(release.canonical(changed))
            self.install(package)
            with self.subTest(size=size), self.assertRaises((ValueError, EOFError, OSError)):
                self.fetch()
            self.assert_no_source()

    def test_fetch_checks_existing_thirteen_scene_catalog_contract(self):
        package, _ = self.packed()
        self.install(package)
        with self.assertRaisesRegex(ValueError, "staging_scene_source_catalog_incomplete"):
            self.fetch(catalog=release.DEFAULT_CATALOG)
        self.assert_no_source()
        catalog = release.read_json(release.DEFAULT_CATALOG)
        scenes = ["test-scene"] + [room["sceneId"] for room in catalog["rooms"]]
        for scene in scenes[1:]:
            directory = self.source / "assets/scenes" / scene
            directory.mkdir()
            (directory / "scene.json").write_bytes(release.canonical({"sceneId": scene, "glbPath": "scene.glb"}))
            (directory / "scene.glb").write_bytes(b"fixture GLB")
        (self.source / "assets/manifest.json").write_bytes(release.canonical({
            "schemaVersion": 1, "scenesRoot": "scenes",
            "scenes": [{"sceneDir": scene} for scene in scenes],
        }))
        self.git("add", ".")
        self.git("commit", "-qm", "complete catalog")
        self.sha = self.git("rev-parse", "HEAD").strip()
        full = self.root / "full"
        release.pack(self.source, self.sha, full)
        self.install(full)
        self.fetch(catalog=release.DEFAULT_CATALOG)
        self.assertEqual(len(catalog["rooms"]), 13)
        self.assertTrue((self.output / "assets/scenes/sense-hall2-v1/scene.glb").is_file())

    def test_fetch_insufficient_space_and_atomic_publish_failure_leave_no_source(self):
        package, _ = self.packed()
        self.install(package)
        with patch.object(release.shutil, "disk_usage", return_value=type("Usage", (), {"free": 1})()):
            with self.assertRaisesRegex(ValueError, "insufficient_disk_space"):
                self.fetch()
        self.assert_no_source()
        original = release.os.rename

        def fail_rename(source, target):
            self.assertFalse(self.output.exists())
            self.assertTrue((source / "assets/manifest.json").is_file())
            raise OSError("simulated publication failure")

        with patch.object(release.os, "rename", fail_rename), self.assertRaises(OSError):
            self.fetch()
        self.assert_no_source()
        self.assertIs(release.os.rename, original)

    def test_fetch_bad_manifest_required_glb_and_catalog_mismatch_block_publication(self):
        package, _ = self.packed()
        original_descriptor = (package / "release.json").read_bytes()
        original_archive = (package / "bundle.tar.gz").read_bytes()
        variants = [
            ("assets/manifest.json", {"schemaVersion": 1, "scenesRoot": "../scenes",
                                      "scenes": [{"sceneDir": "test-scene"}]}),
            ("assets/manifest.json", {"schemaVersion": 1, "scenesRoot": "scenes", "scenes": []}),
            ("assets/scenes/test-scene/scene.json", {"sceneId": "test-scene", "glbPath": "../outside"}),
            ("assets/scenes/test-scene/scene.json", {"sceneId": "test-scene", "glbPath": "missing.glb"}),
            ("assets/scenes/test-scene/scene.json", {"sceneId": "wrong", "glbPath": "scene.glb"}),
        ]
        for path, value in variants:
            (package / "release.json").write_bytes(original_descriptor)
            (package / "bundle.tar.gz").write_bytes(original_archive)
            data = release.canonical(value)
            inventory = json.loads((package / "inventory.json").read_text())
            for entry in inventory["files"]:
                if entry["path"] == path:
                    entry.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
            inventory_data = release.canonical(inventory)

            def change(members):
                result = []
                for member, body in members:
                    body = data if member.name == path else inventory_data if member.name == "inventory.json" else body
                    member.size = len(body)
                    result.append((member, body))
                return result

            record = self.rewrite_archive(package, change)
            record["inventory"].update(bytes=len(inventory_data), sha256=hashlib.sha256(inventory_data).hexdigest(),
                                       totalBytes=sum(e["bytes"] for e in inventory["files"]))
            (package / "release.json").write_bytes(release.canonical(record))
            self.install(package)
            with self.subTest(path=path, value=value), self.assertRaises(ValueError):
                self.fetch()
            self.assert_no_source()

    def test_fetch_cli_rejects_secret_endpoint_without_echo(self):
        endpoint = "https://embedded-key:embedded-secret@s3.example.invalid"
        result = self.cli("fetch", "--asset-sha", self.sha, "--catalog", self.catalog,
                          "--output", self.output, "--endpoint", endpoint,
                          "--region", "region-1", "--bucket", "private-bucket")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), "private_scene_release: invalid_https_endpoint")
        self.assertNotIn("embedded", result.stderr + result.stdout)
        self.assertEqual(self.events(), [])
        self.assert_no_source()


if __name__ == "__main__":
    unittest.main(verbosity=2)
