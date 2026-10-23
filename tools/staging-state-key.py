#!/usr/bin/env python3
"""Explicit, idempotent replacement of a development state signing key on its host."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import tempfile


def replace_development_key(env_file, generate=lambda: secrets.token_urlsafe(48)):
    path = Path(env_file).resolve(strict=True)
    original = path.read_bytes()
    info = path.stat()
    lines = original.decode("utf-8").splitlines(keepends=True)
    matches = [(index, re.match(r"^\s*(?:export\s+)?STATE_TOKEN_SECRET\s*=(.*?)(?:\r?\n)?$", line))
               for index, line in enumerate(lines)]
    matches = [(index, match) for index, match in matches if match]
    if len(matches) > 1:
        raise ValueError("identity_state_key_duplicate")
    values = shlex.split(matches[0][1].group(1), comments=True) if matches else []
    if len(values) > 1:
        raise ValueError("identity_state_key_ambiguous")
    old = values[0] if values else ""
    if old.strip() and old.strip() != "dev-state-secret" and not old.strip().startswith("REPLACE_WITH_"):
        return {"stateSigningKey": "already_configured"}
    value = generate()
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", value):
        raise ValueError("identity_state_key_generator_invalid")
    if matches:
        index = matches[0][0]
        ending = "\r\n" if lines[index].endswith("\r\n") else "\n" if lines[index].endswith("\n") else ""
        lines[index] = "STATE_TOKEN_SECRET=" + value + ending
    else:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append("STATE_TOKEN_SECRET=" + value + "\n")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".state-key-", delete=False) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), info.st_uid, info.st_gid)
            output.write("".join(lines).encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        if path.read_bytes() != original:
            raise ValueError("identity_state_key_env_changed")
        os.replace(temporary, path)
        temporary = None
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"stateSigningKey": "replaced_development_key", "requiresSessionAndInviteReissue": True}


def ensure_proxy_key(env_file, generate=lambda: secrets.token_urlsafe(48)):
    """Provision a separate proxy proof without rotating sessions or existing keys."""
    path = Path(env_file).resolve(strict=True)
    original = path.read_bytes()
    info = path.stat()
    lines = original.decode("utf-8").splitlines(keepends=True)
    matches = [(index, re.match(r"^\s*(?:export\s+)?VRATA_IDENTITY_PROXY_TOKEN\s*=(.*?)(?:\r?\n)?$", line))
               for index, line in enumerate(lines)]
    matches = [(index, match) for index, match in matches if match]
    if len(matches) > 1:
        raise ValueError("identity_proxy_key_duplicate")
    values = shlex.split(matches[0][1].group(1), comments=True) if matches else []
    if len(values) > 1:
        raise ValueError("identity_proxy_key_ambiguous")
    existing = values[0].strip() if values else ""
    if existing and not existing.startswith("REPLACE_WITH_"):
        if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", existing):
            raise ValueError("identity_proxy_key_invalid")
        return {"identityProxyKey": "already_configured"}
    value = generate()
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", value):
        raise ValueError("identity_proxy_key_generator_invalid")
    if matches:
        index = matches[0][0]
        ending = "\r\n" if lines[index].endswith("\r\n") else "\n" if lines[index].endswith("\n") else ""
        lines[index] = "VRATA_IDENTITY_PROXY_TOKEN=" + value + ending
    else:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append("VRATA_IDENTITY_PROXY_TOKEN=" + value + "\n")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".identity-proxy-key-", delete=False) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), info.st_uid, info.st_gid)
            output.write("".join(lines).encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        if path.read_bytes() != original:
            raise ValueError("identity_proxy_key_env_changed")
        os.replace(temporary, path)
        temporary = None
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"identityProxyKey": "provisioned"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--ensure-proxy-key", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(ensure_proxy_key(args.env_file) if args.ensure_proxy_key else replace_development_key(args.env_file)))
    except (ValueError, OSError, UnicodeError) as error:
        message = str(error)
        prefix = "identity_proxy_key_" if args.ensure_proxy_key else "identity_state_key_"
        raise SystemExit(message if message.startswith(prefix) else f"{prefix}update_failed") from None
