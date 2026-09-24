import json, pathlib, subprocess, sys
root, expected = sys.argv[1:]
sha = (pathlib.Path(root) / 'infra/docker/.staging-successful-image-tag').read_text().strip()
assert sha == expected, 'unexpected_staging_sha'
fmt = '{"image":{{json .Config.Image}},"status":{{json .State.Status}},"health":{{json .State.Health.Status}}}'
containers = {}
for service in ['api','room-state','remote-browser']:
    result = subprocess.run(['docker','inspect','--format',fmt,'noah-'+service+'-1'],check=True,capture_output=True,text=True)
    data = json.loads(result.stdout)
    assert data['image'].endswith(':'+sha), 'unexpected_container_sha'
    assert data['status']=='running' and data['health']=='healthy', 'container_not_healthy'
    containers[service] = data
print(json.dumps({'sha':sha,'containers':containers}))
