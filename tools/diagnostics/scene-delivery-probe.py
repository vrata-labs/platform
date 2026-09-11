"""Bounded read-only delivery measurements; never uploads scene bytes."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.parse import urljoin, urlparse

HOST = "state.158.160.10.234.sslip.io"
VERSIONS = {"previous": "6110679a24c2a95179729b2f8c2c1a20f3227c50", "candidate": "2a29d1e1e9ce4bea08cbfa5720df4b1a312834f2"}
SCENES = {"Hall": "sense-hall2-v1", "BlueOffice": "sense-blueoffice-glb-v4"}
MODE = sys.argv[1] if len(sys.argv) > 1 else "runner"
if MODE not in ("runner", "origin"):
    raise SystemExit("invalid_mode")
CACHE = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / "vrata-scene-probe-cache"
if MODE == "runner":
    CACHE.mkdir(exist_ok=True)
ALLOWED = {"http_code", "http_version", "remote_ip", "size_download", "speed_download", "time_namelookup", "time_connect", "time_appconnect", "time_starttransfer", "time_total", "num_connects", "exitcode", "errormsg"}
HEADERS = {"content-length", "content-type", "content-encoding", "cache-control", "etag", "last-modified", "server", "access-control-allow-origin"}

def measure(url, label, protocol="h2", keep=None):
    if urlparse(url).scheme != "https" or urlparse(url).hostname != HOST:
        raise ValueError("unexpected_asset_origin")
    with tempfile.TemporaryDirectory(prefix="vrata-probe-") as d:
        dest = Path(d) / "body"
        headers = Path(d) / "headers"
        cmd = ["curl", "--silent", "--show-error", "--fail", "--connect-timeout", "10", "--max-time", "90", "--max-filesize", "268435456", "--http1.1" if protocol == "h1" else "--http2", "--output", str(dest), "--dump-header", str(headers), "--write-out", "%{json}"]
        if MODE == "origin":
            cmd += ["--resolve", HOST + ":443:127.0.0.1"]
        started = time.time()
        p = subprocess.run(cmd + [url], capture_output=True, text=True, timeout=100)
        try:
            raw = json.loads(p.stdout)
        except json.JSONDecodeError:
            raw = {"errormsg": p.stderr[-500:]}
        h = {}
        if headers.exists():
            for line in headers.read_text(errors="replace").splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    if k.lower() in HEADERS:
                        h[k.lower()] = v.strip()
        sample = {"kind": "transfer", "mode": MODE, "label": label, "requested_protocol": protocol, "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)), "url": url, "returncode": p.returncode, "headers": h, **{k: v for k, v in raw.items() if k in ALLOWED}}
        data = dest.read_bytes() if dest.exists() else b""
        if p.returncode == 0:
            sample["sha256"] = hashlib.sha256(data).hexdigest()
            if keep:
                keep.write_bytes(data)
        print(json.dumps(sample), flush=True)
        return data if p.returncode == 0 else None, sample

print(json.dumps({"kind": "environment", "mode": MODE, "curl": subprocess.run(["curl", "--version"], capture_output=True, text=True).stdout.splitlines()[0], "cpu_count": os.cpu_count(), "load_average": os.getloadavg()}), flush=True)
assets = []
for scene, directory in SCENES.items():
    for version, sha in VERSIONS.items():
        manifest_url = f"https://{HOST}/assets/scenes/{directory}/{sha}/scene.json"
        body, sample = measure(manifest_url, f"{scene}:{version}:manifest")
        if body is None:
            continue
        manifest = json.loads(body)
        asset_url = urljoin(manifest_url, manifest["glbPath"])
        if urlparse(asset_url).hostname != HOST or not urlparse(asset_url).path.endswith(".glb"):
            print(json.dumps({"kind": "unsupported_asset", "scene": scene}), flush=True)
            continue
        asset = {"scene": scene, "version": version, "manifest_url": manifest_url, "url": asset_url, "manifest_sha256": hashlib.sha256(body).hexdigest()}
        for protocol in ("h2", "h1"):
            keep = CACHE / f"{scene}-{version}.glb" if MODE == "runner" and protocol == "h2" else None
            _, result = measure(asset_url, f"{scene}:{version}:serial", protocol, keep)
            if keep and result["returncode"] == 0:
                asset["cache_file"] = str(keep)
                asset["sha256"] = result["sha256"]
        assets.append(asset)
if MODE == "runner":
    (CACHE / "index.json").write_text(json.dumps(assets))
    for scene in SCENES:
        matches = [a for a in assets if a["scene"] == scene and a["version"] == "candidate"]
        if not matches:
            continue
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda n: measure(matches[0]["url"], f"{scene}:candidate:parallel-{n}"), [1, 2]))
print(json.dumps({"kind": "finished", "mode": MODE, "load_average": os.getloadavg()}), flush=True)
