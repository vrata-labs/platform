#!/usr/bin/env python3
"""Guard catalog changes and image downgrades outside the target git checkout.

The successful deploy gate records the first compatible Wave 2 image once. Neither
catalog activation nor subsequent successful deployments may replace that marker.
No room or volume is deleted by this tool.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("template_rollout_invalid_sha")
    return value


def supports_references(contract):
    return (isinstance(contract, dict) and contract.get("schemaVersion") == 1
            and contract.get("templateSchema") == 2
            and contract.get("referenceTemplateVersions") == ["1.0.0", "2.0.0"])


def assert_target_allowed(marker, status, target_contract, target_sha):
    sha(target_sha)
    if marker:
        sha(marker)
        if not supports_references(target_contract):
            raise ValueError("template_rollback_below_wave2_forbidden")
    if status and not supports_references(target_contract):
        if status["state"] != "wave2" or status["referenceRoomCount"] != 0:
            raise ValueError("template_rollback_requires_reference_capable_image")


class CatalogHost:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.marker_path = self.root / "infra/docker/.template-wave2-rollback-sha"
        self.success_path = self.root / "infra/docker/.staging-successful-image-tag"
        self.compose = ["docker", "compose", "--env-file", str(self.root / "infra/docker/.env.staging"),
                        "-f", str(self.root / "infra/docker/compose.staging.yml")]

    def run(self, args, optional=False):
        result = subprocess.run(args, cwd=self.root, stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=600)
        if result.returncode:
            if optional:
                return None
            # Docker stderr can contain configuration values; do not echo it.
            raise RuntimeError("template_rollout_command_failed:" + args[0])
        return result.stdout.strip()

    def marker(self):
        return sha(self.marker_path.read_text().strip()) if self.marker_path.exists() else None

    def contract(self, target):
        result = self.run(["git", "-c", f"safe.directory={self.root}", "show",
                           f"{sha(target)}:infra/docker/template-rollout.json"], optional=True)
        return json.loads(result) if result else None

    def container(self):
        container = self.run(self.compose + ["ps", "-q", "api"])
        if not container or "\n" in container:
            raise RuntimeError("template_rollout_running_api_required")
        return container

    def image_sha(self, container):
        image = self.run(["docker", "inspect", "--format", "{{.Config.Image}}", container])
        return sha(image.rsplit(":", 1)[-1])

    def cli(self, args, required=True):
        container = self.container()
        present = self.run(["docker", "exec", container, "test", "-f", "apps/api/dist/template-catalog-cli.js"], optional=True)
        if present is None:
            if required or self.marker():
                raise RuntimeError("template_rollout_cli_required")
            return None
        env = ["-e", f"VRATA_TEMPLATE_WAVE2_SHA={self.marker() or ''}"]
        result = self.run(["docker", "exec", *env, container, "node", "apps/api/dist/template-catalog-cli.js", *args])
        payload = json.loads(result)
        if args[0] != "preflight" and payload.get("imageSha") != self.image_sha(container):
            raise RuntimeError("template_rollout_running_image_mismatch")
        return payload

    def record_wave2(self, expected):
        status = self.cli(["status"], required=False)
        if status is None:
            return {"wave2Marker": None}
        if status["imageSha"] != sha(expected):
            raise ValueError("template_rollout_image_mismatch")
        if not supports_references(self.contract(expected)):
            raise ValueError("template_rollout_contract_missing")
        if not self.marker():
            if status["state"] != "wave2":
                raise ValueError("template_rollout_wave2_gate_required")
            if not self.success_path.exists() or self.success_path.read_text().strip() != expected:
                raise ValueError("template_rollout_successful_gate_required")
            # Exclusive creation: concurrent/repeated calls cannot overwrite it.
            with self.marker_path.open("x") as output:
                output.write(expected + "\n")
                output.flush()
                os.fsync(output.fileno())
        return {"wave2Marker": self.marker(), "state": status["state"]}

    def prepare(self, target):
        marker = self.marker()
        contract = self.contract(target)
        # This path must work even when a failed rollout has stopped the API.
        # Query PostgreSQL directly; only CLI mutations need a healthy API image.
        result = self.run(self.compose + ["exec", "-T", "postgres", "sh", "-c",
                         'psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', "sh",
                         "select json_build_object('state', case when exists (select 1 from templates where status = 'active' and current_version <> '0.1.0') then 'active' else 'wave2' end, 'referenceRoomCount', (select count(*) from rooms where template_version <> '0.1.0'))"])
        status = json.loads(result)
        assert_target_allowed(marker, status, contract, target)
        # Preparation never silently changes availability. A deliberate return to
        # Wave 2 uses rollback first; compatible routine deploys preserve catalog.
        return {"targetSha": target, "wave2Marker": marker, "state": status["state"]}

    def mutate(self, command, expected):
        marker = self.marker()
        if not marker or not supports_references(self.contract(marker)):
            raise ValueError("template_rollout_verified_wave2_required")
        status = self.cli(["status"])
        if status["imageSha"] != sha(expected):
            raise ValueError("template_rollout_image_mismatch")
        args = [command, "--expected-image-sha", expected]
        if command == "activate":
            if not self.success_path.exists() or self.success_path.read_text().strip() != expected:
                raise ValueError("template_rollout_successful_gate_required")
            args += ["--rollback-sha", marker]
        result = self.cli(args)
        if result["state"] != ("active" if command == "activate" else "wave2"):
            raise RuntimeError("template_rollout_catalog_state_mismatch")
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["status", "preflight", "record-wave2", "prepare", "activate", "rollback"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--sha")
    args = parser.parse_args()
    host = CatalogHost(args.root)
    if args.command in ("status", "preflight"):
        result = host.cli([args.command])
        if args.command == "status":
            result["wave2Marker"] = host.marker()
    elif args.command == "record-wave2":
        result = host.record_wave2(sha(args.sha))
    elif args.command == "prepare":
        result = host.prepare(sha(args.sha))
    else:
        result = host.mutate(args.command, sha(args.sha))
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        raise SystemExit(str(error)) from None
