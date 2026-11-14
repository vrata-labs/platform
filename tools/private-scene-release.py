#!/usr/bin/env python3
"""Deterministic private assets releases. Credentials are read only from AWS_* env."""

import argparse
import base64
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit


PREFIX = "private-scenes/releases"
CHUNK = 1024 * 1024
MAX_JSON = 4 * CHUNK
MAX_ARCHIVE = 4 * 1024 * CHUNK  # Single conditional PutObject, never multipart.
MAX_FILES = 100000
DEFAULT_CATALOG = Path(__file__).resolve().parent.parent / "infra/docker/staging-scene-catalog.json"


def require(condition, code):
    if not condition:
        raise ValueError(code)


def checked_sha(value, length=40):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{%d}" % length, value),
            "invalid_sha")
    return value


def integer(value, minimum=0, maximum=MAX_ARCHIVE):
    require(type(value) is int and minimum <= value <= maximum, "invalid_size")
    return value


def relative_path(value):
    require(isinstance(value, str) and value and not value.startswith("/")
            and "\\" not in value and not any(ord(c) < 32 or ord(c) == 127 for c in value)
            and all(p not in ("", ".", "..", ".git") for p in value.split("/")),
            "invalid_path")
    return value


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate_json_key")
        result[key] = value
    return result


def read_json(path):
    require(Path(path).stat().st_size <= MAX_JSON, "json_too_large")
    with Path(path).open("rb") as stream:
        try:
            return json.load(stream, object_pairs_hook=unique_object)
        except RecursionError:
            raise ValueError("invalid_json") from None


def digest_file(path):
    digest, size = hashlib.sha256(), 0
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def descriptor_key(asset_sha):
    return f"{PREFIX}/{checked_sha(asset_sha)}/release.json"


def archive_key(asset_sha, archive_sha):
    return f"{PREFIX}/{checked_sha(asset_sha)}/{checked_sha(archive_sha, 64)}/bundle.tar.gz"


def validate_descriptor(record):
    require(isinstance(record, dict) and set(record) == {
        "schemaVersion", "assetSha", "archive", "inventory", "scenes", "provenance"},
        "invalid_descriptor")
    require(type(record["schemaVersion"]) is int and record["schemaVersion"] == 1,
            "invalid_descriptor_version")
    asset_sha = checked_sha(record["assetSha"])
    archive, inventory, provenance = record["archive"], record["inventory"], record["provenance"]
    validate_archive(archive, asset_sha)
    validate_inventory_summary(inventory)
    scenes = record["scenes"]
    require(isinstance(scenes, list) and 0 < len(scenes) <= MAX_FILES
            and all(isinstance(s, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*", s) for s in scenes)
            and scenes == sorted(set(scenes)), "invalid_scenes")
    require(isinstance(provenance, dict) and set(provenance) == {"sourceCommit", "assetsTree"},
            "invalid_provenance")
    require(checked_sha(provenance["sourceCommit"]) == asset_sha, "source_identity_mismatch")
    checked_sha(provenance["assetsTree"])
    return record


def validate_archive(record, asset_sha):
    require(isinstance(record, dict) and set(record) == {"key", "bytes", "sha256"},
            "invalid_archive")
    require(record["key"] == archive_key(asset_sha, record["sha256"]), "invalid_archive_key")
    integer(record["bytes"], 1)


def validate_inventory_summary(record):
    require(isinstance(record, dict) and set(record) == {
        "bytes", "sha256", "fileCount", "totalBytes"}, "invalid_inventory")
    checked_sha(record["sha256"], 64)
    integer(record["bytes"], 1, MAX_JSON)
    integer(record["fileCount"], 1, MAX_FILES)
    integer(record["totalBytes"], 1, 16 * MAX_ARCHIVE)


def validate_lock(record):
    require(isinstance(record, dict) and set(record) == {
        "schemaVersion", "assetSha", "descriptor", "archive", "inventory"}
        and type(record["schemaVersion"]) is int and record["schemaVersion"] == 1, "invalid_lock")
    asset_sha = checked_sha(record["assetSha"])
    descriptor = record["descriptor"]
    require(isinstance(descriptor, dict) and set(descriptor) == {"key", "bytes", "sha256"}
            and descriptor["key"] == descriptor_key(asset_sha), "invalid_descriptor_key")
    integer(descriptor["bytes"], 1, MAX_JSON)
    checked_sha(descriptor["sha256"], 64)
    validate_archive(record["archive"], asset_sha)
    validate_inventory_summary(record["inventory"])
    return record


def validate_inventory(record):
    require(isinstance(record, dict) and set(record) == {"schemaVersion", "files"}
            and type(record["schemaVersion"]) is int and record["schemaVersion"] == 1
            and isinstance(record["files"], list) and 0 < len(record["files"]) <= MAX_FILES,
            "invalid_inventory")
    paths = []
    for entry in record["files"]:
        require(isinstance(entry, dict) and set(entry) == {"path", "bytes", "sha256"},
                "invalid_inventory_entry")
        path = relative_path(entry["path"])
        parts = path.split("/")
        require(path == "assets/manifest.json" or (len(parts) >= 4 and parts[:2] == ["assets", "scenes"]
                and re.fullmatch(r"[a-z0-9][a-z0-9-]*", parts[2])),
                "invalid_inventory_path")
        integer(entry["bytes"])
        checked_sha(entry["sha256"], 64)
        paths.append(path)
    require(paths == sorted(set(paths)) and "assets/manifest.json" in paths, "invalid_inventory_order")
    return record


def git(source, *args):
    # Never include git output (which may contain authenticated remotes) in errors.
    try:
        result = subprocess.run(["git", "-C", str(source), *args], capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError("source_git_unavailable") from None
    require(result.returncode == 0, "source_git_failed")
    return result.stdout


def source_inventory(source, asset_sha):
    require(source.is_dir() and not (source / "assets").is_symlink(), "invalid_source")
    require(git(source, "rev-parse", f"{asset_sha}^{{commit}}").decode().strip() == asset_sha,
            "source_commit_missing")
    tracked = {}
    for item in git(source, "ls-tree", "-rz", asset_sha, "--", "assets").split(b"\0"):
        if not item:
            continue
        meta, raw_path = item.split(b"\t", 1)
        mode, kind, blob = meta.decode().split()
        require(mode in ("100644", "100755") and kind == "blob", "source_not_regular")
        path = relative_path(raw_path.decode("utf-8"))
        tracked[path] = blob
    require(tracked, "source_assets_missing")
    actual, entries = set(), []

    def fail(error):
        raise error

    for directory, directories, files in os.walk(source / "assets", followlinks=False, onerror=fail):
        for name in directories:
            require(stat.S_ISDIR((Path(directory) / name).lstat().st_mode), "source_not_regular")
        for name in files:
            path = Path(directory) / name
            relative = relative_path(path.relative_to(source).as_posix())
            require(relative in tracked, "source_untracked_asset")
            metadata = path.lstat()
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "source_not_regular")
            digest = hashlib.sha256()
            blob = hashlib.sha1(f"blob {metadata.st_size}\0".encode(), usedforsecurity=False)
            size = 0
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(CHUNK), b""):
                    digest.update(chunk)
                    blob.update(chunk)
                    size += len(chunk)
            require(size == metadata.st_size and blob.hexdigest() == tracked[relative],
                    "source_bytes_differ_from_commit")
            entries.append({"path": relative, "bytes": size, "sha256": digest.hexdigest()})
            actual.add(relative)
    require(actual == set(tracked), "source_assets_incomplete")
    record = validate_inventory({"schemaVersion": 1, "files": sorted(entries, key=lambda e: e["path"])})
    manifest = read_json(source / "assets/manifest.json")
    require(isinstance(manifest, dict) and manifest.get("schemaVersion") == 1
            and manifest.get("scenesRoot") == "scenes" and isinstance(manifest.get("scenes"), list),
            "invalid_source_manifest")
    scenes = []
    for entry in manifest["scenes"]:
        require(isinstance(entry, dict), "invalid_source_scene")
        scene = entry.get("sceneDir")
        require(isinstance(scene, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*", scene)
                and scene not in scenes, "invalid_source_scene")
        require(f"assets/scenes/{scene}/scene.json" in actual, "source_scene_missing")
        scenes.append(scene)
    require(set(scenes) == {p.split("/")[2] for p in actual if p.startswith("assets/scenes/")},
            "source_catalog_mismatch")
    require(scenes, "source_catalog_empty")
    return record, sorted(scenes)


class HashingReader:
    def __init__(self, stream):
        self.stream, self.digest, self.size = stream, hashlib.sha256(), 0

    def read(self, size=-1):
        chunk = self.stream.read(size)
        self.digest.update(chunk)
        self.size += len(chunk)
        return chunk


def tar_entry(archive, name, size, stream):
    entry = tarfile.TarInfo(name)
    entry.size, entry.mode, entry.mtime = size, 0o644, 0
    entry.uid = entry.gid = 0
    entry.uname = entry.gname = ""
    archive.addfile(entry, stream)


def pack(source, asset_sha, output):
    asset_sha = checked_sha(asset_sha)
    source, output = Path(source).resolve(), Path(output).absolute()
    require(not output.resolve().is_relative_to(source), "output_inside_source")
    inventory, scenes = source_inventory(source, asset_sha)
    inventory_bytes = canonical(inventory)
    require(len(inventory_bytes) <= MAX_JSON, "inventory_too_large")
    assets_tree = git(source, "rev-parse", f"{asset_sha}:assets").decode().strip()
    output.mkdir(mode=0o700)  # No reuse/overwrite of a partial or previous package.
    try:
        archive_path = output / "bundle.tar.gz"
        with archive_path.open("xb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as gz:
                with tarfile.open(fileobj=gz, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                    # inventory is metadata; every source entry is byte-for-byte unchanged.
                    for entry in inventory["files"]:
                        path = source / entry["path"]
                        require(stat.S_ISREG(path.lstat().st_mode), "source_not_regular")
                        with path.open("rb") as stream:
                            hashed = HashingReader(stream)
                            tar_entry(archive, entry["path"], entry["bytes"], hashed)
                        require(hashed.size == entry["bytes"] and hashed.digest.hexdigest() == entry["sha256"],
                                "source_changed_during_pack")
                    tar_entry(archive, "inventory.json", len(inventory_bytes), io.BytesIO(inventory_bytes))
        require(source_inventory(source, asset_sha) == (inventory, scenes), "source_changed_during_pack")
        size, digest = digest_file(archive_path)
        descriptor = validate_descriptor({
            "schemaVersion": 1, "assetSha": asset_sha,
            "archive": {"key": archive_key(asset_sha, digest), "bytes": size, "sha256": digest},
            "inventory": {"bytes": len(inventory_bytes),
                          "sha256": hashlib.sha256(inventory_bytes).hexdigest(),
                          "fileCount": len(inventory["files"]),
                          "totalBytes": sum(e["bytes"] for e in inventory["files"])},
            "scenes": scenes, "provenance": {"sourceCommit": asset_sha, "assetsTree": assets_tree},
        })
        (output / "inventory.json").write_bytes(inventory_bytes)
        (output / "release.json").write_bytes(canonical(descriptor))  # Complete marker last.
        for path in output.iterdir():
            path.chmod(0o600)
        return descriptor
    except BaseException:
        shutil.rmtree(output)  # Only this invocation's exclusively created directory.
        raise


class S3Error(ValueError):
    pass


class S3:
    """Only standard S3 operations; no profiles, metadata credentials, ACL or policy writes."""

    def __init__(self, endpoint, region, bucket, timeout=300, addressing_style="virtual"):
        url = urlsplit(endpoint or "")
        require(url.scheme == "https" and url.hostname and not url.username and not url.password
                and url.path in ("", "/") and not url.query and not url.fragment
                and not any(c.isspace() for c in endpoint)
                and (url.port is None or 1 <= url.port <= 65535), "invalid_https_endpoint")
        require(re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,62}", region or ""), "invalid_region")
        require(re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket or "")
                and ".." not in bucket, "invalid_bucket")
        integer(timeout, 1, 900)
        require(addressing_style in ("virtual", "path"), "invalid_addressing_style")
        require(os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"),
                "missing_env_credentials")
        self.endpoint, self.region, self.bucket, self.timeout = endpoint, region, bucket, timeout
        self.addressing_style = addressing_style

    def call(self, operation, *args):
        env = {k: v for k, v in os.environ.items() if not k.startswith("AWS_")}
        for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
            if key in os.environ:
                env[key] = os.environ[key]
        # Isolated config also prevents credential_process / user endpoint overrides.
        with tempfile.TemporaryDirectory(prefix="private-scenes-aws-") as temporary:
            config = Path(temporary) / "config"
            config.write_text(f"[default]\ns3 =\n    addressing_style = {self.addressing_style}\n")
            config.chmod(0o600)
            env.update({
                "AWS_CONFIG_FILE": str(config), "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
                "AWS_EC2_METADATA_DISABLED": "true", "AWS_MAX_ATTEMPTS": "1",
                "AWS_RETRY_MODE": "standard", "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off",
                "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true",
                "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
                "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required",
            })
            command = ["aws", "--endpoint-url", self.endpoint, "--region", self.region,
                       "--cli-connect-timeout", str(min(10, self.timeout)),
                       "--cli-read-timeout", str(min(60, self.timeout)), "--output", "json",
                       "s3api", operation, "--bucket", self.bucket, *map(str, args)]
            try:
                result = subprocess.run(command, capture_output=True, env=env, timeout=self.timeout)
            except subprocess.TimeoutExpired:
                raise S3Error("s3_timeout") from None
            except OSError:
                raise S3Error("aws_cli_unavailable") from None
        if result.returncode:
            for marker, code in (
                (b"Could not connect to the endpoint URL", "s3_connection_failed"),
                (b"Read timeout on endpoint URL", "s3_timeout"),
                (b"Connect timeout on endpoint URL", "s3_timeout"),
                (b"SSL validation failed", "s3_tls_failed"),
            ):
                if marker in result.stderr:
                    raise S3Error(code)
            match = re.search(rb"An error occurred \(([A-Za-z0-9]+)\) when calling", result.stderr)
            code = match[1].decode() if match else ""
            allowed = {"NoSuchKey", "NotFound", "404", "AccessDenied", "403",
                       "PreconditionFailed", "412", "ConditionalRequestConflict",
                       "NotImplemented", "InvalidRequest"}
            raise S3Error("s3_" + (code if code in allowed else "cli_failed"))
        try:
            return json.loads(result.stdout or b"{}", object_pairs_hook=unique_object)
        except (ValueError, UnicodeError, RecursionError):
            raise S3Error("s3_invalid_response") from None

    def existing(self, key, path):
        expected_size, expected_digest = digest_file(path)
        try:
            head = self.call("head-object", "--key", key)
        except S3Error as error:
            if str(error) in ("s3_NoSuchKey", "s3_NotFound", "s3_404"):
                return False
            raise
        require(isinstance(head, dict) and type(head.get("ContentLength")) is int
                and head["ContentLength"] == expected_size, "release_conflict")
        with tempfile.TemporaryDirectory(prefix="private-scenes-check-") as temporary:
            target = Path(temporary) / "object"
            self.call("get-object", "--key", key, target)
            require(target.is_file() and digest_file(target) == (expected_size, expected_digest),
                    "release_conflict")
        return True

    def ensure(self, key, path):
        if self.probe(key, path):
            return
        digest = hashlib.md5(usedforsecurity=False)
        with Path(path).open("rb") as stream:
            for chunk in iter(lambda: stream.read(CHUNK), b""):
                digest.update(chunk)
        try:
            self.call("put-object", "--key", key, "--body", path, "--if-none-match", "*",
                      "--content-md5", base64.b64encode(digest.digest()).decode())
        except S3Error as error:
            # A racing writer or lost response is accepted only after full byte verification.
            if str(error) not in ("s3_PreconditionFailed", "s3_412",
                                  "s3_ConditionalRequestConflict", "s3_timeout"):
                raise
            if not self.existing(key, path):
                raise error
            return
        require(self.existing(key, path), "s3_publication_not_visible")

    def probe(self, key, path):
        try:
            return self.existing(key, path)
        except S3Error as error:
            # With no ListBucket permission S3 can hide an absent key behind 403.
            # Unknown is NOT absence: only conditional PUT may resolve this safely.
            if str(error) in ("s3_AccessDenied", "s3_403"):
                return None
            raise

    def download(self, key, path, limit, expected=None):
        # HEAD bounds disk use before GET; a bounded Range also caps an oversized object.
        # Neither 403 nor 404 selects another identity or an alternate source.
        head = self.call("head-object", "--key", key)
        require(isinstance(head, dict), "s3_invalid_response")
        size = integer(head.get("ContentLength"), 1, limit)
        require(expected is None or size == expected["bytes"], "download_size_mismatch")
        response = self.call("get-object", "--key", key, "--range", f"bytes=0-{size}", path)
        require(isinstance(response, dict) and type(response.get("ContentLength")) is int
                and response["ContentLength"] == size, "download_size_mismatch")
        require(Path(path).is_file() and Path(path).stat().st_size == size, "download_size_mismatch")
        if expected is not None:
            require(digest_file(path) == (size, expected["sha256"]), "download_digest_mismatch")


def unpack_archive(path, destination, descriptor):
    """Read USTAR blocks ourselves: tarfile's iterator silently accepts extension headers.

    Only regular files from pack are supported. Reject directories too: parents are
    created by us, so a directory header cannot smuggle modes, links or empty trees.
    Never use extract/extractall or buffer the compressed/uncompressed archive.
    """
    expected = descriptor["inventory"]
    seen, count, total, metadata_seen = set(), 0, 0, False
    with gzip.open(path, "rb") as stream:
        while True:
            block = stream.read(tarfile.BLOCKSIZE)
            require(len(block) == tarfile.BLOCKSIZE, "archive_truncated")
            if block == b"\0" * tarfile.BLOCKSIZE:
                require(stream.read(tarfile.BLOCKSIZE) == block, "invalid_tar_end")
                # Validate gzip CRC/trailer and reject appended/concatenated payloads.
                padding = stream.read(tarfile.RECORDSIZE + 1)
                require(len(padding) <= tarfile.RECORDSIZE and not padding.strip(b"\0"),
                        "invalid_tar_trailer")
                break
            member = tarfile.TarInfo.frombuf(block, "utf-8", "strict")
            require(block[257:263] == b"ustar\0", "invalid_tar_format")
            require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE)
                    and member.linkname == "" and member.sparse is None, "archive_not_regular")
            name = relative_path(member.name)
            require(name not in seen, "archive_duplicate_path")
            seen.add(name)
            size = integer(member.size)
            if name == "inventory.json":
                require(size == expected["bytes"], "inventory_size_mismatch")
                metadata_seen = True
            else:
                parts = name.split("/")
                require(name == "assets/manifest.json" or (len(parts) >= 4
                        and parts[:2] == ["assets", "scenes"]
                        and parts[2] in descriptor["scenes"]), "archive_unexpected_path")
                count += 1
                total += size
                require(count <= expected["fileCount"] and total <= expected["totalBytes"],
                        "archive_limits_exceeded")
            output = destination / name
            require(output.resolve().is_relative_to(destination), "archive_path_escape")
            output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            # No archive-controlled links exist, and the exclusively owned tree is private.
            with output.open("xb") as target:
                output.chmod(0o600)
                remaining = size
                while remaining:
                    chunk = stream.read(min(CHUNK, remaining))
                    require(chunk, "archive_truncated")
                    target.write(chunk)
                    remaining -= len(chunk)
            padding_size = -size % tarfile.BLOCKSIZE
            require(stream.read(padding_size) == b"\0" * padding_size, "invalid_tar_padding")
    require(metadata_seen and count == expected["fileCount"] and total == expected["totalBytes"],
            "archive_inventory_incomplete")


def verify_source(source, descriptor, catalog):
    """Full on-disk verification, also used for an already published destination."""
    require(stat.S_ISDIR(source.lstat().st_mode), "destination_not_directory")
    for name in ("inventory.json", "release.json"):
        metadata = (source / name).lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "source_not_regular")
    require(digest_file(source / "inventory.json") == (
        descriptor["inventory"]["bytes"], descriptor["inventory"]["sha256"]), "inventory_mismatch")
    inventory = validate_inventory(read_json(source / "inventory.json"))
    require((source / "inventory.json").read_bytes() == canonical(inventory), "noncanonical_inventory")
    expected = descriptor["inventory"]
    require(len(inventory["files"]) == expected["fileCount"]
            and sum(e["bytes"] for e in inventory["files"]) == expected["totalBytes"],
            "inventory_mismatch")
    entries, directories = [], set()
    allowed_directories = set()
    for entry in inventory["files"]:
        allowed_directories.update(p.as_posix() for p in Path(entry["path"]).parents if p != Path("."))

    def fail(error):
        raise error

    for directory, dirs, files in os.walk(source, followlinks=False, onerror=fail):
        for name in dirs:
            path = Path(directory) / name
            require(stat.S_ISDIR(path.lstat().st_mode), "source_not_regular")
            directories.add(path.relative_to(source).as_posix())
        for name in files:
            path = Path(directory) / name
            metadata = path.lstat()
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "source_not_regular")
            relative = path.relative_to(source).as_posix()
            if relative in ("inventory.json", "release.json"):
                continue
            size, digest = digest_file(path)
            entries.append({"path": relative, "bytes": size, "sha256": digest})
    require(directories == allowed_directories
            and sorted(entries, key=lambda e: e["path"]) == inventory["files"], "source_inventory_mismatch")
    require((source / "release.json").read_bytes() == canonical(descriptor), "release_conflict")
    manifest = read_json(source / "assets/manifest.json")
    require(isinstance(manifest, dict) and type(manifest.get("schemaVersion")) is int
            and manifest["schemaVersion"] == 1 and manifest.get("scenesRoot") == "scenes"
            and isinstance(manifest.get("scenes"), list), "invalid_source_manifest")
    scenes = []
    for entry in manifest["scenes"]:
        require(isinstance(entry, dict), "invalid_source_scene")
        scene = entry.get("sceneDir")
        require(isinstance(scene, str) and scene in descriptor["scenes"] and scene not in scenes,
                "invalid_source_scene")
        scenes.append(scene)
    require(sorted(scenes) == descriptor["scenes"]
            == sorted({e["path"].split("/")[2] for e in entries if e["path"].startswith("assets/scenes/")}),
            "source_catalog_mismatch")
    # Use the same rooms/sceneId contract as staging_scene_files.prepare_snapshot.
    # Do not duplicate the thirteen IDs or reinterpret legacy (non-required) scenes.
    require(isinstance(catalog, dict) and catalog.get("schemaVersion") == 1
            and isinstance(catalog.get("rooms"), list) and catalog["rooms"], "invalid_catalog")
    required = set()
    for room in catalog["rooms"]:
        require(isinstance(room, dict) and isinstance(room.get("sceneId"), str)
                and re.fullmatch(r"[a-z0-9][a-z0-9-]*", room["sceneId"]), "invalid_catalog")
        required.add(room["sceneId"])
    require(required.issubset(scenes), "staging_scene_source_catalog_incomplete")
    paths = {e["path"] for e in entries}
    for scene in scenes:
        require(f"assets/scenes/{scene}/scene.json" in paths, "source_scene_missing")
    for scene in required:
        record = read_json(source / "assets/scenes" / scene / "scene.json")
        require(isinstance(record, dict) and record.get("sceneId") == scene
                and isinstance(record.get("glbPath"), str), "invalid_required_scene")
        glb = relative_path(record["glbPath"])
        require(f"assets/scenes/{scene}/{glb}" in paths, "source_required_glb_missing")


def fetch(output, storage, asset_sha=None, lock=None, catalog=DEFAULT_CATALOG):
    require((asset_sha is None) != (lock is None), "exactly_one_release_identity_required")
    if lock is not None:
        lock = validate_lock(read_json(lock))
        asset_sha = lock["assetSha"]
    asset_sha = checked_sha(asset_sha)
    catalog = read_json(catalog)
    output = Path(output).absolute()
    relative_path(output.name)
    # Require a caller-owned existing parent; do not create a usable destination early.
    parent = output.parent.resolve(strict=True)
    output = parent / output.name
    with tempfile.TemporaryDirectory(prefix=".private-scene-fetch-", dir=parent) as temporary:
        temporary = Path(temporary)
        descriptor_path = temporary / "release.json"
        storage.download(descriptor_key(asset_sha), descriptor_path, MAX_JSON,
                         lock["descriptor"] if lock else None)
        descriptor = validate_descriptor(read_json(descriptor_path))
        require(descriptor["assetSha"] == asset_sha, "release_identity_mismatch")
        require(descriptor_path.read_bytes() == canonical(descriptor), "noncanonical_descriptor")
        if lock:
            require(all(descriptor[key] == lock[key] for key in ("archive", "inventory")), "lock_mismatch")
        needed = descriptor["archive"]["bytes"] + descriptor["inventory"]["totalBytes"] + 2 * MAX_JSON
        require(shutil.disk_usage(parent).free >= needed, "insufficient_disk_space")
        archive = temporary / "bundle.tar.gz"
        storage.download(descriptor["archive"]["key"], archive, MAX_ARCHIVE, descriptor["archive"])
        candidate = temporary / "source"
        candidate.mkdir(mode=0o700)
        unpack_archive(archive, candidate, descriptor)
        shutil.copyfile(descriptor_path, candidate / "release.json")
        (candidate / "release.json").chmod(0o600)
        verify_source(candidate, descriptor, catalog)
        # Serialize cooperating fetches, without persistent lock files. Never replace
        # an existing source, even when it is incomplete or its identity has changed.
        directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(directory_fd, fcntl.LOCK_EX)
            if os.path.lexists(output):
                require(stat.S_ISDIR(output.lstat().st_mode), "destination_not_directory")
                metadata = (output / "release.json").lstat()
                require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "source_not_regular")
                require(read_json(output / "release.json") == descriptor, "release_conflict")
                verify_source(output, descriptor, catalog)
            else:
                os.rename(candidate, output)
        finally:
            os.close(directory_fd)
    return descriptor


def publish(package, storage):
    # Freeze before network I/O: a concurrent local edit must not poison an immutable key.
    package = Path(package)
    with tempfile.TemporaryDirectory(prefix="private-scenes-publish-") as temporary:
        frozen = Path(temporary)
        for name in ("release.json", "inventory.json", "bundle.tar.gz"):
            path = package / name
            metadata = path.lstat()
            require(stat.S_ISREG(metadata.st_mode), "package_not_regular")
            limit = MAX_ARCHIVE if name == "bundle.tar.gz" else MAX_JSON
            require(metadata.st_size <= limit, "package_too_large")
            with path.open("rb") as source, (frozen / name).open("xb") as output:
                size = 0
                for chunk in iter(lambda: source.read(CHUNK), b""):
                    size += len(chunk)
                    require(size <= limit, "package_too_large")
                    output.write(chunk)
            (frozen / name).chmod(0o400)
        return publish_snapshot(frozen, storage)


def publish_snapshot(package, storage):
    package = Path(package)
    descriptor_path, inventory_path, archive_path = [package / name for name in
                                                     ("release.json", "inventory.json", "bundle.tar.gz")]
    for path in (descriptor_path, inventory_path, archive_path):
        require(stat.S_ISREG(path.lstat().st_mode), "package_not_regular")
    descriptor = validate_descriptor(read_json(descriptor_path))
    inventory = validate_inventory(read_json(inventory_path))
    require(descriptor_path.read_bytes() == canonical(descriptor)
            and inventory_path.read_bytes() == canonical(inventory), "noncanonical_package")
    expected = descriptor["inventory"]
    require(digest_file(inventory_path) == (expected["bytes"], expected["sha256"])
            and len(inventory["files"]) == expected["fileCount"]
            and sum(e["bytes"] for e in inventory["files"]) == expected["totalBytes"],
            "inventory_mismatch")
    require(descriptor["scenes"] == sorted({e["path"].split("/")[2]
            for e in inventory["files"] if e["path"].startswith("assets/scenes/")}),
            "inventory_catalog_mismatch")
    require(digest_file(archive_path) == (descriptor["archive"]["bytes"], descriptor["archive"]["sha256"]),
            "archive_mismatch")
    key = descriptor_key(descriptor["assetSha"])
    storage.probe(key, descriptor_path)  # Reject a readable ID conflict before uploading archive bytes.
    storage.ensure(descriptor["archive"]["key"], archive_path)
    storage.ensure(key, descriptor_path)  # Publish pointer only after archive read-back succeeds.
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    pack_args = sub.add_parser("pack")
    pack_args.add_argument("--source", required=True, help="Git repository containing assets/")
    pack_args.add_argument("--asset-sha", required=True, help="Full source Git commit (40 lowercase hex)")
    pack_args.add_argument("--output", required=True, help="New private package directory outside source")
    publish_args = sub.add_parser("publish")
    publish_args.add_argument("--package", required=True)
    fetch_args = sub.add_parser("fetch")
    identity = fetch_args.add_mutually_exclusive_group(required=True)
    identity.add_argument("--asset-sha", help="Exact saved binding; no lock or newer-release fallback")
    identity.add_argument("--lock", help="Pinned release lock JSON for a new candidate")
    fetch_args.add_argument("--output", required=True, help="Atomic source directory; pass output/assets to rollout")
    fetch_args.add_argument("--catalog", default=str(DEFAULT_CATALOG), help="Pinned staging-scene-catalog.json")
    for storage_args in (publish_args, fetch_args):
        storage_args.add_argument("--endpoint", default=os.environ.get("VRATA_SCENES_S3_ENDPOINT"))
        storage_args.add_argument("--region", default=os.environ.get("VRATA_SCENES_S3_REGION"))
        storage_args.add_argument("--bucket", default=os.environ.get("VRATA_SCENES_S3_BUCKET"))
        storage_args.add_argument("--timeout", type=int, default=300, help="AWS invocation deadline, 1..900 seconds")
        storage_args.add_argument("--addressing-style", choices=("virtual", "path"), default="virtual")
    args = parser.parse_args()
    try:
        if args.command == "pack":
            result = pack(args.source, args.asset_sha, args.output)
        else:
            storage = S3(args.endpoint, args.region, args.bucket, args.timeout, args.addressing_style)
            result = (publish(args.package, storage) if args.command == "publish" else
                      fetch(args.output, storage, args.asset_sha, args.lock, args.catalog))
        print(json.dumps({"assetSha": result["assetSha"], "descriptorKey": descriptor_key(result["assetSha"]),
                          "archive": result["archive"], "inventory": result["inventory"],
                          "sceneCount": len(result["scenes"])}, sort_keys=True))
        return 0
    except (ValueError, OSError, UnicodeError, tarfile.TarError, EOFError) as error:
        # Paths, endpoints, raw CLI messages and environment contents never enter logs.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-zA-Z0-9_]+", str(error)) else "release_io_error"
        print(f"private_scene_release: {code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
