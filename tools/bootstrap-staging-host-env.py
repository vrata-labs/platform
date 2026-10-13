#!/usr/bin/env python3
"""Generate private staging configuration once; preserve established host secrets."""

import argparse
import importlib.util
import ipaddress
import json
from pathlib import Path
import secrets
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
spec = importlib.util.spec_from_file_location("staging_release_state", Path(__file__).with_name("staging-accepted-release.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def parse_env(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value.strip().strip('"').strip("'")
    return values


def bootstrap_env(root, public_ip, image_sha, registry_id="crp9cm29k6p76hqo8lti"):
    root = Path(root).resolve()
    public_ip = str(ipaddress.IPv4Address(public_ip))
    module.checked_sha(image_sha)
    state = module.AcceptedState(root)
    path = root / "infra/docker/.env.staging"
    if module.regular_file_exists(path):
        existing = parse_env(path)
        if existing.get("LIVEKIT_NODE_IP") != public_ip or existing.get("VRATA_STAGING_STATE_DIR") != str(state.directory):
            raise ValueError("staging_bootstrap_existing_host_mismatch")
        if state.manifest() is None:
            state.designate(public_ip)
        else:
            state.preflight()
        return {"created": False}
    values = parse_env(root / "infra/docker/.env.staging.example")
    domain = f"{public_ip}.sslip.io"
    origin = f"https://{domain}"
    values.update({
        "COMPOSE_PROJECT_NAME": "vrata", "IMAGE_TAG": image_sha,
        "API_IMAGE_REPO": f"cr.yandex/{registry_id}/vrata-api",
        "ROOM_STATE_IMAGE_REPO": f"cr.yandex/{registry_id}/vrata-room-state",
        "REMOTE_BROWSER_IMAGE_REPO": f"cr.yandex/{registry_id}/vrata-remote-browser",
        "VRATA_APP_BASE_URL": origin, "VRATA_APP_DOMAIN": domain,
        "VRATA_STATE_DOMAIN": f"state.{domain}", "VRATA_LIVEKIT_DOMAIN": f"livekit.{domain}",
        "VRATA_BROWSER_DOMAIN": f"browser.{domain}", "VRATA_STORAGE_DOMAIN": f"storage.{domain}",
        "LIVEKIT_NODE_IP": public_ip, "ROOM_STATE_PUBLIC_URL": f"wss://state.{domain}",
        "LIVEKIT_URL": f"wss://livekit.{domain}", "REMOTE_BROWSER_PUBLIC_URL": f"wss://browser.{domain}",
        "VRATA_ALLOW_INSECURE_PRODUCTION_URLS": "false",
        "REMOTE_BROWSER_ALLOWED_ORIGINS": "https://rutube.ru,https://*.rutube.ru,https://*.rtbcdn.ru",
        "REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS": "false",
        "VRATA_HTTP_PORT": "80", "VRATA_HTTPS_PORT": "443", "VRATA_API_DIRECT_PORT": "4000",
        "VRATA_LIVEKIT_UDP_PORT": "7882",
        "LIVEKIT_TURN_ENABLED": "true", "LIVEKIT_TURN_DOMAIN": f"turn.{domain}",
        "LIVEKIT_TURN_TLS_PORT": "", "LIVEKIT_TURN_EXTERNAL_TLS": "false",
        "LIVEKIT_API_KEY": secrets.token_hex(12), "LIVEKIT_API_SECRET": secrets.token_urlsafe(48),
        "REMOTE_BROWSER_ENABLED": "true", "MINIO_ROOT_USER": "vrata-minio",
        "MINIO_PUBLIC_BASE_URL": f"https://storage.{domain}",
        "VRATA_STAGING_PUBLIC_IP": public_ip,
        "VRATA_STAGING_STATE_DIR": str(state.directory),
        "VRATA_STAGING_SCENE_ROOT": "/srv/staging-state/active/public",
        "CADDY_CONFIG_FILE": "./Caddyfile.staging",
    })
    for key in ("CONTROL_PLANE_ADMIN_TOKEN", "STATE_TOKEN_SECRET", "REMOTE_BROWSER_TOKEN_SECRET",
                "VRATA_INTERNAL_SERVICE_TOKEN", "REMOTE_BROWSER_INTERNAL_TOKEN", "POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD"):
        values[key] = secrets.token_urlsafe(48)
    values["POSTGRES_URL"] = f'postgres://{values["POSTGRES_USER"]}:{values["POSTGRES_PASSWORD"]}@postgres:5432/{values["POSTGRES_DB"]}'
    content = "# Private host configuration, generated once.\n" + "\n".join(f"{key}={value}" for key, value in values.items()) + "\n"
    module.atomic_write(path, content)
    state.designate(public_ip)
    return {"created": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--public-ip", required=True)
    parser.add_argument("--image-sha", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(bootstrap_env(args.root, args.public_ip, args.image_sha)))
    except (ValueError, OSError):
        raise SystemExit("staging_host_configuration_failed") from None
