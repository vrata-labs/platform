#!/bin/sh
set -eu

runtime_dir="${XDG_RUNTIME_DIR:-/tmp/noah-runtime}"
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
export XDG_RUNTIME_DIR="$runtime_dir"

Xvfb :99 -screen 0 "${REMOTE_BROWSER_VIEWPORT_WIDTH:-1280}x${REMOTE_BROWSER_VIEWPORT_HEIGHT:-720}x24" >/tmp/noah-xvfb.log 2>&1 &
export DISPLAY=:99

pulseaudio --start --exit-idle-time=-1 --log-target=file:/tmp/noah-pulseaudio.log >/tmp/noah-pulseaudio-start.log 2>&1 || true
for attempt in 1 2 3 4 5; do
  if pactl info >/tmp/noah-pactl.log 2>&1; then
    break
  fi
  sleep 1
done

pactl load-module module-null-sink sink_name=noah_browser_audio sink_properties=device.description=NoahBrowserAudio >/tmp/noah-pulse-sink.log 2>&1 || true
pactl set-default-sink noah_browser_audio >/tmp/noah-pulse-default-sink.log 2>&1 || true
pactl set-default-source noah_browser_audio.monitor >/tmp/noah-pulse-default-source.log 2>&1 || true
export PULSE_SINK=noah_browser_audio
export PULSE_SOURCE=noah_browser_audio.monitor

exec node apps/remote-browser/dist/index.js
