#!/usr/bin/env python3
"""Deterministic private assets releases. Credentials are read only from AWS_* env."""

import argparse
import base64
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
        return json.load(stream, object_pairs_hook=unique_object)


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
    require(isinstance(archive, dict) and set(archive) == {"key", "bytes", "sha256"},
            "invalid_archive")
    require(archive["key"] == archive_key(asset_sha, archive["sha256"]), "invalid_archive_key")
    integer(archive["bytes"], 1)
    require(isinstance(inventory, dict) and set(inventory) == {
        "bytes", "sha256", "fileCount", "totalBytes"}, "invalid_inventory")
    checked_sha(inventory["sha256"], 64)
    integer(inventory["bytes"], 1, MAX_JSON)
    integer(inventory["fileCount"], 1, MAX_FILES)
    integer(inventory["totalBytes"], 1, 16 * MAX_ARCHIVE)
    scenes = record["scenes"]
    require(isinstance(scenes, list) and 0 < len(scenes) <= MAX_FILES
            and all(isinstance(s, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*", s) for s in scenes)
            and scenes == sorted(set(scenes)), "invalid_scenes")
    require(isinstance(provenance, dict) and set(provenance) == {"sourceCommit", "assetsTree"},
            "invalid_provenance")
    require(checked_sha(provenance["sourceCommit"]) == asset_sha, "source_identity_mismatch")
    checked_sha(provenance["assetsTree"])
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
        require(path == "assets/manifest.json" or path.startswith("assets/scenes/"),
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
        except (ValueError, UnicodeError):
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
    publish_args.add_argument("--endpoint", default=os.environ.get("VRATA_SCENES_S3_ENDPOINT"))
    publish_args.add_argument("--region", default=os.environ.get("VRATA_SCENES_S3_REGION"))
    publish_args.add_argument("--bucket", default=os.environ.get("VRATA_SCENES_S3_BUCKET"))
    publish_args.add_argument("--timeout", type=int, default=300, help="AWS invocation deadline, 1..900 seconds")
    publish_args.add_argument("--addressing-style", choices=("virtual", "path"), default="virtual")
    args = parser.parse_args()
    try:
        if args.command == "pack":
            result = pack(args.source, args.asset_sha, args.output)
        else:
            result = publish(args.package, S3(args.endpoint, args.region, args.bucket,
                                               args.timeout, args.addressing_style))
        print(json.dumps({"assetSha": result["assetSha"], "descriptorKey": descriptor_key(result["assetSha"]),
                          "archive": result["archive"], "inventory": result["inventory"],
                          "sceneCount": len(result["scenes"])}, sort_keys=True))
        return 0
    except (ValueError, OSError, UnicodeError, tarfile.TarError) as error:
        # Paths, endpoints, raw CLI messages and environment contents never enter logs.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-zA-Z0-9_]+", str(error)) else "release_io_error"
        print(f"private_scene_release: {code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
