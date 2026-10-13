"""Strict post-gate evidence shared by staging publication and catalog guards."""

import json
from pathlib import Path
import re
import stat


def checked_sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("staging_gate_proof_invalid_sha")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("staging_json_duplicate_key")
        result[key] = value
    return result


def read_json(path, max_bytes=65536):
    path = Path(path)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > max_bytes:
        raise ValueError("staging_json_invalid_file")
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    except (json.JSONDecodeError, UnicodeError):
        raise ValueError("staging_json_invalid") from None


def validate_gate_proof(proof, image_sha=None):
    keys = {"schemaVersion", "imageSha", "runId", "runAttempt", "gate"}
    if not isinstance(proof, dict) or set(proof) != keys:
        raise ValueError("staging_gate_proof_invalid_schema")
    if type(proof["schemaVersion"]) is not int or proof["schemaVersion"] != 1:
        raise ValueError("staging_gate_proof_invalid_schema")
    checked_sha(proof["imageSha"])
    if not isinstance(proof["runId"], str) or not re.fullmatch(r"[1-9][0-9]*", proof["runId"]):
        raise ValueError("staging_gate_proof_invalid_run")
    if type(proof["runAttempt"]) is not int or proof["runAttempt"] < 1 or proof["gate"] != "passed":
        raise ValueError("staging_gate_proof_not_passed")
    if image_sha is not None and proof["imageSha"] != checked_sha(image_sha):
        raise ValueError("staging_gate_proof_image_mismatch")
    return proof


def load_gate_proof(path, root, image_sha=None):
    path, root = Path(path).absolute(), Path(root).resolve()
    if path.resolve().is_relative_to(root):
        raise ValueError("staging_gate_proof_inside_checkout")
    return validate_gate_proof(read_json(path), image_sha)
