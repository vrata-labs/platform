#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCENES_ROOT="${SCENES_ROOT:-$ROOT_DIR/apps/runtime-web/public/assets/scenes}"
VERSION="${STAGING_SCENE_BUNDLE_VERSION:-${DEPLOY_SHA:-${GITHUB_SHA:-}}}"
SCENE_IDS="${STAGING_SCENE_IDS:-}"

usage() {
  cat >&2 <<'EOF'
usage: snapshot-scene-assets.sh --version <full-git-sha> --scene <scene-id> [--scene <scene-id> ...]

Environment alternatives:
  STAGING_SCENE_BUNDLE_VERSION=<full-git-sha>
  STAGING_SCENE_IDS=scene-a,scene-b
  SCENES_ROOT=/path/to/assets/scenes
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --scene)
      if [ -z "${2:-}" ]; then
        usage
        exit 2
      fi
      if [ -n "$SCENE_IDS" ]; then
        SCENE_IDS="$SCENE_IDS,$2"
      else
        SCENE_IDS="$2"
      fi
      shift 2
      ;;
    --root)
      SCENES_ROOT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown_argument:$1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "missing_scene_bundle_version" >&2
  exit 2
fi

if ! [[ "$VERSION" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "invalid_scene_bundle_version:expected_full_git_sha" >&2
  exit 2
fi

if [ -z "$SCENE_IDS" ]; then
  echo "missing_scene_ids" >&2
  exit 2
fi

if [ ! -d "$SCENES_ROOT" ]; then
  echo "missing_scenes_root:$SCENES_ROOT" >&2
  exit 2
fi

is_snapshot_dir() {
  local path="$1"
  local name
  name="$(basename "$path")"
  [ -f "$path/.noah-scene-snapshot" ] && return 0
  [[ "$name" =~ ^[0-9a-fA-F]{40}$ ]] && return 0
  return 1
}

IFS=',' read -r -a scenes <<< "$SCENE_IDS"
for scene_id in "${scenes[@]}"; do
  scene_id="${scene_id//[[:space:]]/}"
  [ -n "$scene_id" ] || continue

  source_dir="$SCENES_ROOT/$scene_id"
  target_dir="$source_dir/$VERSION"
  tmp_dir="$source_dir/.snapshot-$VERSION.tmp"

  if [ ! -d "$source_dir" ]; then
    echo "missing_scene_dir:$scene_id:$source_dir" >&2
    exit 2
  fi
  if [ ! -f "$source_dir/scene.json" ]; then
    echo "missing_scene_manifest:$scene_id:$source_dir/scene.json" >&2
    exit 2
  fi
  if [ -e "$target_dir" ]; then
    echo "snapshot_exists:$scene_id:$target_dir"
    continue
  fi

  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"
  for entry in "$source_dir"/*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    [ "$name" = "$VERSION" ] && continue
    [[ "$name" == .snapshot-* ]] && continue
    if [ -d "$entry" ] && is_snapshot_dir "$entry"; then
      continue
    fi
    cp -a "$entry" "$tmp_dir/"
  done
  printf 'version=%s\nsource=%s\n' "$VERSION" "$scene_id" > "$tmp_dir/.noah-scene-snapshot"
  mv "$tmp_dir" "$target_dir"
  echo "snapshot_created:$scene_id:$target_dir"
done
