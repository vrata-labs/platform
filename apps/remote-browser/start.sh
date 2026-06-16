#!/bin/sh
set -eu

runtime_dir="${XDG_RUNTIME_DIR:-/tmp/vrata-runtime}"
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
export XDG_RUNTIME_DIR="$runtime_dir"

Xvfb :99 -screen 0 "${REMOTE_BROWSER_VIEWPORT_WIDTH:-1280}x${REMOTE_BROWSER_VIEWPORT_HEIGHT:-720}x24" >/tmp/vrata-xvfb.log 2>&1 &
export DISPLAY=:99

pulseaudio --start --exit-idle-time=-1 --log-target=file:/tmp/vrata-pulseaudio.log >/tmp/vrata-pulseaudio-start.log 2>&1 || true
for attempt in 1 2 3 4 5; do
  if pactl info >/tmp/vrata-pactl.log 2>&1; then
    break
  fi
  sleep 1
done

pactl load-module module-null-sink sink_name=vrata_browser_audio sink_properties=device.description=VrataBrowserAudio >/tmp/vrata-pulse-sink.log 2>&1 || true
# Chromium does not expose PulseAudio monitor sources as microphone devices directly.
pactl load-module module-remap-source master=vrata_browser_audio.monitor source_name=vrata_browser_audio_input source_properties=device.description=VrataBrowserAudioInput >/tmp/vrata-pulse-source.log 2>&1 || true
pactl set-default-sink vrata_browser_audio >/tmp/vrata-pulse-default-sink.log 2>&1 || true
pactl set-default-source vrata_browser_audio_input >/tmp/vrata-pulse-default-source.log 2>&1 || true
export PULSE_SINK=vrata_browser_audio
export PULSE_SOURCE=vrata_browser_audio_input

exec node apps/remote-browser/dist/index.js
