#!/usr/bin/env python3
"""Prepare, verify or select staging scene snapshots without modifying checkout."""

import argparse
import importlib.util
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from staging_gate_proof import read_json
from staging_scene_files import activate_snapshot, prepare_snapshot, verify_snapshot

spec = importlib.util.spec_from_file_location("staging_release_state", Path(__file__).with_name("staging-accepted-release.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "verify", "activate"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--state-dir")
    parser.add_argument("--source")
    parser.add_argument("--image-sha", required=True)
    parser.add_argument("--asset-sha", required=True)
    args = parser.parse_args()
    state = module.AcceptedState(args.root, args.state_dir)
    if args.command == "prepare":
        if not args.source:
            raise ValueError("staging_scene_source_required")
        catalog = read_json(state.root / "infra/docker/staging-scene-catalog.json")
        result = prepare_snapshot(state, args.source, args.image_sha, args.asset_sha, catalog)
    elif args.command == "activate":
        result = activate_snapshot(state, args.image_sha, args.asset_sha)
    else:
        record = verify_snapshot(state.directory / "snapshots" / f"{args.image_sha}-{args.asset_sha}", args.image_sha, args.asset_sha)
        result = {"verified": True, "files": len(record["files"])}
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        message = str(error)
        if not message.startswith(("staging_scene_", "staging_json_", "accepted_release_", "staging_gate_proof_")):
            message = "staging_scene_operation_failed"
        raise SystemExit(message) from None
