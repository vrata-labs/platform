"""Read aggregate TCP counters of Caddy's network namespace, no client addresses."""
import json
import os
from pathlib import Path
import subprocess
import time
pid = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Pid}}', 'noah-caddy-1'], text=True).strip()
if not pid.isdecimal() or int(pid) <= 0:
    raise SystemExit('invalid_caddy_pid')
result = {'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'load_average': os.getloadavg()}
allowed = {'InSegs', 'OutSegs', 'RetransSegs', 'InErrs', 'OutRsts', 'CurrEstab', 'TCPTimeouts', 'TCPLossProbes', 'TCPFastRetrans', 'TCPSlowStartRetrans', 'TCPSynRetrans', 'TCPRetransFail', 'TCPSpuriousRTOs', 'TCPOrigDataSent', 'TCPDelivered'}
for file in ['snmp', 'netstat']:
    lines = Path('/proc/' + pid + '/net/' + file).read_text().splitlines()
    for i in range(0, len(lines) - 1, 2):
        keys, vals = lines[i].split(), lines[i + 1].split()
        if keys[0] not in ('Tcp:', 'TcpExt:'):
            continue
        for key, val in zip(keys[1:], vals[1:]):
            if key in allowed:
                result[keys[0].rstrip(':') + '.' + key] = int(val)
print(json.dumps(result))
