#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${1:-noah-staging}"

yc compute instance get "$INSTANCE_NAME" --format json | node -e 'const fs=require("fs");const data=JSON.parse(fs.readFileSync(0,"utf8"));const iface=data.network_interfaces?.[0];const ip=iface?.primary_v4_address?.one_to_one_nat?.address; if(!ip){process.exit(1)} console.log(ip)'
