"""Immutable scene-byte snapshots and an atomic active pointer, without git overlays."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
from urllib.parse import urlsplit

from staging_gate_proof import checked_sha, read_json


def directory_exists(path):
    try:
        metadata = Path(path).lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("staging_scene_snapshot_invalid_directory")
    return True


def safe_relative(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("staging_scene_snapshot_invalid_path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in (".", "..") for part in value.split("/")):
        raise ValueError("staging_scene_snapshot_invalid_path")
    return path


def inventory(root):
    root = Path(root)
    if not directory_exists(root):
        raise ValueError("staging_scene_snapshot_missing")
    result = []
    def fail(error):
        raise error
    for directory, directories, files in os.walk(root, followlinks=False, onerror=fail):
        for name in directories:
            metadata = (Path(directory) / name).lstat()
            if not stat.S_ISDIR(metadata.st_mode):
                raise ValueError("staging_scene_snapshot_symlink")
        for name in files:
            path = Path(directory) / name
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError("staging_scene_snapshot_symlink")
            digest = hashlib.sha256()
            with path.open("rb") as data:
                for chunk in iter(lambda: data.read(1024 * 1024), b""):
                    digest.update(chunk)
            result.append({"path": path.relative_to(root).as_posix(), "bytes": metadata.st_size, "sha256": digest.hexdigest()})
    return sorted(result, key=lambda entry: entry["path"])


def verify_snapshot(path, image_sha, asset_sha):
    path = Path(path)
    if not directory_exists(path):
        raise ValueError("staging_scene_snapshot_missing")
    record = read_json(path / "snapshot.json", max_bytes=4 * 1024 * 1024)
    if (not isinstance(record, dict) or set(record) != {"schemaVersion", "imageSha", "assetSha", "scenes", "files"}
            or record["schemaVersion"] != 1 or type(record["schemaVersion"]) is not int
            or record["imageSha"] != checked_sha(image_sha) or record["assetSha"] != checked_sha(asset_sha)
            or not isinstance(record["scenes"], list) or not isinstance(record["files"], list)):
        raise ValueError("staging_scene_snapshot_identity_mismatch")
    actual = inventory(path / "public")
    if actual != record["files"]:
        raise ValueError("staging_scene_snapshot_bytes_mismatch")
    if not actual or len(set(record["scenes"])) != len(record["scenes"]):
        raise ValueError("staging_scene_snapshot_invalid_inventory")
    for scene in record["scenes"]:
        if not isinstance(scene, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", scene):
            raise ValueError("staging_scene_snapshot_invalid_scene")
        manifest = read_json(path / "public/assets/scenes" / scene / "scene.json")
        if manifest.get("sceneId") != scene or not manifest.get("glbPath"):
            raise ValueError("staging_scene_snapshot_invalid_manifest")
        target = path / "public/assets/scenes" / scene / safe_relative(manifest["glbPath"])
        if not stat.S_ISREG(target.lstat().st_mode):
            raise ValueError("staging_scene_snapshot_missing_glb")
    return record


def prepare_snapshot(state, source, image_sha, asset_sha, catalog, room_snapshot=None):
    image_sha, asset_sha = checked_sha(image_sha), checked_sha(asset_sha)
    state.bind(image_sha, asset_sha)
    source = Path(source).resolve()
    manifest = read_json(source / "manifest.json")
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("scenes"), list):
        raise ValueError("staging_scene_source_invalid_manifest")
    source_root = source / safe_relative(manifest.get("scenesRoot"))
    scenes = []
    for entry in manifest["scenes"]:
        scene = entry.get("sceneDir") or entry.get("sceneId")
        if not isinstance(scene, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", scene) or scene in scenes:
            raise ValueError("staging_scene_source_invalid_scene")
        scenes.append(scene)
    required = {room["sceneId"] for room in catalog["rooms"]}
    if not required.issubset(scenes):
        raise ValueError("staging_scene_source_catalog_incomplete")
    versioned = {room["sceneId"] for room in catalog["rooms"] if room.get("versioned")}
    snapshot_id = f"{image_sha}-{asset_sha}"
    snapshots = state.directory / "snapshots"
    snapshots.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = snapshots / snapshot_id
    with state.locked():
        if directory_exists(target):
            verify_snapshot(target, image_sha, asset_sha)
            return {"snapshotId": snapshot_id}
        temporary = Path(tempfile.mkdtemp(prefix=".scene-candidate-", dir=snapshots))
        try:
            public = temporary / "public"
            for scene in scenes:
                origin = source_root / scene
                entries = inventory(origin)
                if not entries:
                    raise ValueError("staging_scene_source_empty")
                destination = public / "assets/scenes" / scene
                for entry in entries:
                    relative = safe_relative(entry["path"])
                    output = destination / relative
                    output.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(origin / relative, output)
                    if scene in versioned:
                        versioned_output = destination / image_sha / relative
                        versioned_output.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(origin / relative, versioned_output)
                if scene in versioned:
                    (destination / image_sha / ".vrata-scene-snapshot").write_text(
                        f"version={image_sha}\nasset_sha={asset_sha}\nsource={scene}\n")
            previous = state.manifest()
            retained = [] if previous is None else [previous]
            referenced = {}
            if room_snapshot is not None:
                if room_snapshot.get("schemaVersion") != 1 or not isinstance(room_snapshot.get("rooms"), list):
                    raise ValueError("staging_scene_room_snapshot_invalid")
                for room in room_snapshot["rooms"]:
                    url = room.get("sceneBundleUrl")
                    if not isinstance(url, str):
                        continue
                    match = re.fullmatch(r"/assets/scenes/([a-z0-9-]+)/([a-f0-9]{40})/scene\.json", urlsplit(url).path)
                    if match and match[1] in versioned and match[2] != image_sha:
                        referenced.setdefault(match[1], set()).add(match[2])
            marker = state.root / "infra/docker/.template-wave2-rollback-sha"
            if marker.is_file():
                baseline = checked_sha(marker.read_text().strip())
                binding = state.binding(baseline)
                if binding and all(entry["imageSha"] != baseline for entry in retained):
                    retained.append({"imageSha": baseline, "assetSha": binding["assetSha"],
                                     "snapshotId": f'{baseline}-{binding["assetSha"]}'})
            for entry in retained:
                if entry["imageSha"] == image_sha:
                    continue
                old = state.directory / "snapshots" / entry["snapshotId"]
                verify_snapshot(old, entry["imageSha"], entry["assetSha"])
                for scene in versioned:
                    original = old / "public/assets/scenes" / scene / entry["imageSha"]
                    if not directory_exists(original):
                        raise ValueError("staging_scene_previous_version_missing")
                    shutil.copytree(original, public / "assets/scenes" / scene / entry["imageSha"])
            if referenced and previous is not None:
                old = state.directory / "snapshots" / previous["snapshotId"]
                verify_snapshot(old, previous["imageSha"], previous["assetSha"])
                for scene, versions in referenced.items():
                    for version in versions:
                        destination = public / "assets/scenes" / scene / version
                        if destination.exists():
                            continue
                        original = old / "public/assets/scenes" / scene / version
                        if not directory_exists(original):
                            raise ValueError("staging_scene_referenced_version_missing")
                        shutil.copytree(original, destination)
            record = {"schemaVersion": 1, "imageSha": image_sha, "assetSha": asset_sha,
                      "scenes": sorted(scenes), "files": inventory(public)}
            (temporary / "snapshot.json").write_text(json.dumps(record, sort_keys=True, indent=2) + "\n")
            verify_snapshot(temporary, image_sha, asset_sha)
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    return {"snapshotId": snapshot_id}


def activate_snapshot(state, image_sha, asset_sha):
    snapshot_id = f"{checked_sha(image_sha)}-{checked_sha(asset_sha)}"
    with state.locked():
        verify_snapshot(state.directory / "snapshots" / snapshot_id, image_sha, asset_sha)
        active = state.directory / "active"
        try:
            metadata = active.lstat()
        except FileNotFoundError:
            metadata = None
        if metadata is not None and not stat.S_ISLNK(metadata.st_mode):
            raise ValueError("staging_scene_active_path_not_owned")
        fd, temporary = tempfile.mkstemp(prefix=".active-scene-", dir=state.directory)
        os.close(fd)
        os.unlink(temporary)
        try:
            os.symlink(f"snapshots/{snapshot_id}", temporary)
            os.replace(temporary, active)
            directory = os.open(state.directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)
    return {"activeSnapshotId": snapshot_id}


def prune_snapshots(state):
    """Remove obsolete owned trees only after acceptance, retaining rollback bytes."""
    with state.locked():
        release = state.preflight()["release"]
        keep = {release["snapshotId"]}
        previous_path = state.directory / "previous-release.json"
        if previous_path.exists():
            previous = read_json(previous_path)
            image, asset = checked_sha(previous["imageSha"]), checked_sha(previous["assetSha"])
            if previous["snapshotId"] != f"{image}-{asset}":
                raise ValueError("staging_scene_previous_identity_mismatch")
            keep.add(previous["snapshotId"])
        marker = state.root / "infra/docker/.template-wave2-rollback-sha"
        baseline = checked_sha(marker.read_text().strip())
        binding = state.binding(baseline)
        if binding is None:
            raise ValueError("staging_scene_baseline_binding_missing")
        keep.add(f'{baseline}-{binding["assetSha"]}')
        if (state.directory / "active").readlink().as_posix() != f'snapshots/{release["snapshotId"]}':
            raise ValueError("staging_scene_active_identity_mismatch")
        snapshots = state.directory / "snapshots"
        for snapshot_id in keep:
            image, asset = snapshot_id.split("-")
            verify_snapshot(snapshots / snapshot_id, image, asset)
        remove = []
        for path in snapshots.iterdir():
            if re.fullmatch(r"[a-f0-9]{40}-[a-f0-9]{40}", path.name) and path.name not in keep:
                image, asset = path.name.split("-")
                verify_snapshot(path, image, asset)
                remove.append(path)
        # Validate all targets before deleting any. Candidate bindings remain pinned.
        for path in remove:
            shutil.rmtree(path)
        source = state.directory / "source"
        removed_sources = 0
        if directory_exists(source):
            for image in source.iterdir():
                if re.fullmatch(r"[a-f0-9]{40}", image.name) and directory_exists(image):
                    for asset in image.iterdir():
                        if re.fullmatch(r"[a-f0-9]{40}", asset.name) and directory_exists(asset):
                            shutil.rmtree(asset)
                            removed_sources += 1
                    if not any(image.iterdir()):
                        image.rmdir()
        return {"retained": sorted(keep), "removedSnapshots": len(remove), "removedSources": removed_sources}
