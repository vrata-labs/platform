#!/usr/bin/env python3
"""Stage-only scene backup companion. Restore bytes, never host acceptance."""

import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from staging_gate_proof import checked_sha, read_json
from staging_scene_files import directory_exists, inventory, safe_relative, verify_snapshot

spec = importlib.util.spec_from_file_location("recovery_accepted", Path(__file__).with_name("staging-accepted-release.py"))
accepted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accepted)

NAMESPACE = "private-scenes"
KIND = "private-scene-recovery"
MAX_JSON = 32 * 1024 * 1024


def require(condition, code):
    if not condition:
        raise ValueError("private_scene_recovery_" + code)


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def decode_copy(value):
    if value == r"\N":
        return None
    def replace(match):
        text = match[1]
        if text[0] in "01234567":
            return chr(int(text, 8))
        if text[0] == "x":
            return chr(int(text[1:], 16))
        return {"t": "\t", "n": "\n", "r": "\r", "b": "\b", "f": "\f", "v": "\v"}.get(text, text)
    return re.sub(r"\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)", replace, value)


def room_urls(dump):
    """Read only pg_dump's COPY data, not SQL execution or a second live query."""
    rows, seen, columns, copying, found = [], set(), None, False, False
    with Path(dump).open(encoding="utf-8", errors="strict") as stream:
        for line in stream:
            line = line.rstrip("\n")
            if copying:
                if line == r"\.":
                    copying, columns = False, None
                    continue
                if columns is None:
                    continue
                values = [decode_copy(value) for value in line.split("\t")]
                require(len(values) == len(columns), "invalid_room_row")
                row = dict(zip(columns, values))
                room = row["room_id"]
                require(isinstance(room, str) and room and room not in seen, "invalid_room_id")
                seen.add(room)
                template = json.loads(row["template_snapshot"]) if row.get("template_snapshot") is not None else None
                require(template is None or isinstance(template, dict), "invalid_room_template")
                config = template.get("roomConfig") if template else None
                require(config is None or isinstance(config, dict), "invalid_room_template")
                urls = {"roomId": room, "sceneBundleUrl": row["scene_bundle_url"],
                        "templateSceneBundleUrl": config.get("sceneBundleUrl") if config else None}
                require(all(value is None or isinstance(value, str) for key, value in urls.items() if key != "roomId"),
                        "invalid_room_url")
                rows.append(urls)
            elif line.startswith("COPY "):
                copying = True
                match = re.fullmatch(r'COPY (?:"public"|public)\.(?:"rooms"|rooms) \(([^)]+)\) FROM stdin;', line)
                if match:
                    require(not found, "duplicate_rooms_copy")
                    found = True
                    columns = [column.strip().strip('"') for column in match[1].split(",")]
                    require(len(set(columns)) == len(columns) and {"room_id", "scene_bundle_url"}.issubset(columns),
                            "unsupported_rooms_copy")
                else:
                    require(not re.match(r'COPY (?:"public"|public)\.(?:"rooms"|rooms)\b', line), "unsupported_rooms_copy")
    require(found and not copying, "missing_or_truncated_rooms_copy")
    return sorted(rows, key=lambda row: row["roomId"])


def metadata(state):
    release = state.preflight()["release"]
    previous_path = state.directory / "previous-release.json"
    previous = accepted.validate_release(read_json(previous_path)) if accepted.regular_file_exists(previous_path) else None
    marker = state.root / "infra/docker/.template-wave2-rollback-sha"
    require(accepted.regular_file_exists(marker), "wave2_missing")
    wave2 = checked_sha(marker.read_text().strip())
    active = state.directory / "active"
    require(active.is_symlink() and active.readlink().as_posix() == "snapshots/" + release["snapshotId"],
            "active_mismatch")
    # Include every binding in the race check, even those not needed by this export.
    bindings = {}
    binding_dir = state.directory / "bindings"
    require(directory_exists(binding_dir), "bindings_missing")
    for path in sorted(binding_dir.iterdir()):
        require(re.fullmatch(r"[a-f0-9]{40}\.json", path.name) is not None, "invalid_binding_file")
        binding = state.binding(path.stem)
        require(binding is not None, "binding_missing")
        bindings[path.stem] = binding
    return {"acceptedRelease": release, "previousRelease": previous, "wave2ImageSha": wave2, "bindings": bindings}


def required_snapshots(record, bindings):
    release = accepted.validate_release(record["acceptedRelease"])
    previous = record["previousRelease"]
    if previous is not None:
        accepted.validate_release(previous)
    wave2 = checked_sha(record["wave2ImageSha"])
    require(wave2 in bindings, "historical_binding_missing")
    images = {release["imageSha"], wave2}
    if previous is not None:
        images.add(previous["imageSha"])
    for entry in [release, *([previous] if previous is not None else [])]:
        require(bindings.get(entry["imageSha"]) == entry["assetSha"], "release_binding_mismatch")
    return sorted(f"{image}-{bindings[image]}" for image in images)


def references(record, public, scenes, bindings):
    """Every managed URL must resolve in the accepted public tree, not a newer release."""
    needed = set()
    for row in record["roomUrls"]:
        require(isinstance(row, dict) and set(row) == {"roomId", "sceneBundleUrl", "templateSceneBundleUrl"},
                "invalid_room_url")
        for key in ("sceneBundleUrl", "templateSceneBundleUrl"):
            url = row[key]
            require(url is None or isinstance(url, str), "invalid_room_url")
            if url is None:
                continue
            path = unquote(urlsplit(url).path)
            match = re.fullmatch(r"/assets/scenes/([a-z0-9-]+)(?:/([a-f0-9]{40}))?/scene\.json", path)
            managed = re.match(r"/assets/scenes/([^/]+)/", path)
            require(not managed or managed[1] not in scenes or match is not None, "unsupported_managed_url")
            if not match or match[1] not in scenes:
                continue  # Public platform bundles and user uploads are backed up by their own paths.
            scene, version = match.groups()
            directory = public / "assets/scenes" / scene
            if version:
                require(version in bindings, "historical_binding_missing")
                needed.add(version)
                directory /= version
                marker = directory / ".vrata-scene-snapshot"
                require(accepted.regular_file_exists(marker), "room_version_missing")
                require(marker.read_text() == f"version={version}\nasset_sha={bindings[version]}\nsource={scene}\n",
                        "room_version_binding_mismatch")
            require(accepted.regular_file_exists(directory / "scene.json"), "room_version_missing")
            manifest = read_json(directory / "scene.json")
            # verify_snapshot inventories the entire tree, including these retained nested files.
            target = directory / safe_relative(manifest.get("glbPath"))
            require(accepted.regular_file_exists(target), "room_version_missing")
    return needed


def validate_payload(path, release, urls):
    require(directory_exists(path), "payload_missing")
    record = read_json(path / "recovery.json", max_bytes=MAX_JSON)
    require(isinstance(record, dict) and set(record) == {
        "schemaVersion", "mode", "acceptedRelease", "previousRelease", "wave2ImageSha",
        "releases", "snapshots", "roomUrls", "files"}, "invalid_schema")
    require(type(record["schemaVersion"]) is int and record["schemaVersion"] == 1
            and record["mode"] == "included-snapshots", "invalid_schema")
    require(record["acceptedRelease"] == release and record["roomUrls"] == urls, "backup_metadata_mismatch")
    require(isinstance(record["releases"], list), "invalid_releases")
    bindings = {}
    for entry in record["releases"]:
        require(isinstance(entry, dict) and set(entry) == {"imageSha", "assetSha", "descriptorKey"}, "invalid_releases")
        image, asset = checked_sha(entry["imageSha"]), checked_sha(entry["assetSha"])
        require(image not in bindings and entry["descriptorKey"] == f"private-scenes/releases/{asset}/release.json",
                "invalid_releases")
        bindings[image] = asset
    snapshots = required_snapshots(record, bindings)
    require(record["snapshots"] == snapshots, "snapshot_set_mismatch")
    actual = inventory(path)
    require([entry for entry in actual if entry["path"] != "recovery.json"] == record["files"], "inventory_mismatch")
    require(sorted(child.name for child in path.iterdir()) == ["recovery.json", "snapshots"], "unexpected_file")
    require(sorted(child.name for child in (path / "snapshots").iterdir()) == snapshots, "snapshot_set_mismatch")
    current = None
    for snapshot_id in snapshots:
        image, asset = snapshot_id.split("-")
        tree = path / "snapshots" / snapshot_id
        snapshot = verify_snapshot(tree, image, asset)
        require(sorted(child.name for child in tree.iterdir()) == ["public", "snapshot.json"], "unexpected_file")
        if snapshot_id == release["snapshotId"]:
            current = snapshot
    needed = {snapshot_id.split("-")[0] for snapshot_id in snapshots}
    needed.update(references(record, path / "snapshots" / release["snapshotId"] / "public", current["scenes"], bindings))
    require(set(bindings) == needed, "binding_set_mismatch")
    return record


def base_validate(backup):
    result = subprocess.run(["node", str(Path(__file__).with_name("backup-restore.mjs")), "validate",
                             "--backup-dir", str(backup)], stdin=subprocess.DEVNULL, capture_output=True)
    require(result.returncode == 0, "base_backup_invalid")


def validate(backup):
    backup = Path(backup).absolute()
    require(directory_exists(backup), "backup_missing")
    base_validate(backup)
    manifest = read_json(backup / "manifest.json", max_bytes=MAX_JSON)
    release = accepted.validate_release(read_json(backup / "accepted-release.json"))
    require(manifest["source"]["imageTag"] == release["imageSha"], "backup_metadata_mismatch")
    accepted_files = [entry for entry in manifest["artifacts"] if entry["kind"] == "accepted-release"]
    require(len(accepted_files) == 1 and accepted_files[0]["path"] == "accepted-release.json",
            "accepted_artifact_missing")
    dumps = [entry for entry in manifest["artifacts"] if entry["kind"] == "postgres-dump"]
    require(len(dumps) == 1 and dumps[0]["path"] == "postgres.sql", "unsupported_dump_path")
    urls = room_urls(backup / "postgres.sql")
    path = backup / NAMESPACE
    record = validate_payload(path, release, urls)
    expected = [dict(entry, path=NAMESPACE + "/" + entry["path"], kind=KIND) for entry in inventory(path)]
    actual = [entry for entry in manifest["artifacts"]
              if entry.get("kind") == KIND or entry.get("path", "").startswith(NAMESPACE + "/")]
    require(sorted(actual, key=lambda entry: entry["path"]) == expected, "artifact_set_mismatch")
    return record


def copy_private(source, target):
    entries = inventory(source)  # Reject links/special files before copying.
    target.mkdir(mode=0o700)
    for entry in entries:
        destination = target / entry["path"]
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(source / entry["path"], destination)
        destination.chmod(0o600)
    require(inventory(target) == entries, "copy_changed")


def attach(state, backup, before):
    """Caller holds operation + shared state locks across the entire DB/scene export."""
    backup = Path(backup)
    require(metadata(state) == before, "release_changed")
    manifest = read_json(backup / "manifest.json", max_bytes=MAX_JSON)
    release = before["acceptedRelease"]
    require(read_json(backup / "accepted-release.json") == release, "backup_metadata_mismatch")
    urls = room_urls(backup / "postgres.sql")
    bindings = {image: entry["assetSha"] for image, entry in before["bindings"].items()}
    record = {key: before[key] for key in ("acceptedRelease", "previousRelease", "wave2ImageSha")}
    record.update({"schemaVersion": 1, "mode": "included-snapshots", "roomUrls": urls})
    snapshots = required_snapshots(record, bindings)
    current = verify_snapshot(state.directory / "snapshots" / release["snapshotId"],
                              release["imageSha"], release["assetSha"])
    needed = {snapshot_id.split("-")[0] for snapshot_id in snapshots}
    needed.update(references(record, state.directory / "snapshots" / release["snapshotId"] / "public",
                             current["scenes"], bindings))
    record["releases"] = [{"imageSha": image, "assetSha": bindings[image],
                           "descriptorKey": f"private-scenes/releases/{bindings[image]}/release.json"}
                          for image in sorted(needed)]
    record["snapshots"] = snapshots
    path = backup / NAMESPACE
    require(not os.path.lexists(path), "payload_exists")
    path.mkdir(mode=0o700)
    (path / "snapshots").mkdir(mode=0o700)
    for snapshot_id in snapshots:
        image, asset = snapshot_id.split("-")
        source = state.directory / "snapshots" / snapshot_id
        verify_snapshot(source, image, asset)
        copy_private(source, path / "snapshots" / snapshot_id)
    record["files"] = inventory(path)
    write_json(path / "recovery.json", record)
    validate_payload(path, release, urls)
    require(metadata(state) == before, "release_changed")
    require(not any(entry.get("kind") == KIND or entry.get("path", "").startswith(NAMESPACE + "/")
                    for entry in manifest["artifacts"]), "artifact_set_mismatch")
    manifest["artifacts"].extend(dict(entry, path=NAMESPACE + "/" + entry["path"], kind=KIND)
                                for entry in inventory(path))
    accepted.atomic_write(backup / "manifest.json", json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    return record


def restore(backup, output):
    """Publish a standalone byte recovery point, NOT an AcceptedState or a live active pointer."""
    backup = Path(backup).absolute()
    output = Path(output).absolute()
    output = output.parent.resolve() / output.name
    require(output.parent.is_dir() and not output.is_relative_to(backup.resolve()), "invalid_output")
    fd = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        require(not os.path.lexists(output) or
                (directory_exists(output) and not any(output.iterdir())), "output_not_empty")
        record = validate(backup)
        temporary = Path(tempfile.mkdtemp(prefix=".private-scene-recovery-", dir=output.parent))
        copy_private(backup / NAMESPACE, temporary / "payload")
        validate_payload(temporary / "payload", record["acceptedRelease"], record["roomUrls"])
        require(validate(backup) == record, "backup_changed")
        require(not os.path.lexists(output) or
                (directory_exists(output) and not any(output.iterdir())), "output_not_empty")
        os.replace(temporary / "payload", output)
        os.fsync(fd)
        return {"restored": True, "snapshots": len(record["snapshots"]), "releases": len(record["releases"])}
    finally:
        if temporary is not None:
            shutil.rmtree(temporary)
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["validate", "restore"])
    parser.add_argument("--backup-dir", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.command == "restore":
        require(bool(args.output), "output_required")
        result = restore(args.backup_dir, args.output)
    else:
        record = validate(args.backup_dir)
        result = {"validated": True, "snapshots": len(record["snapshots"]), "releases": len(record["releases"])}
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError, TypeError) as error:
        message = str(error)
        if not message.startswith(("private_scene_recovery_", "accepted_release_", "staging_scene_", "staging_json_")):
            message = "private_scene_recovery_failed"
        raise SystemExit(message) from None
