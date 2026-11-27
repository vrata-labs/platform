"""Publish one isolated display and audio sink. stdin is a private controller pipe."""

import asyncio
import json
import sys
import time

from livekit import rtc

WIDTH, HEIGHT, FPS = 1280, 720, 12
SAMPLE_RATE, AUDIO_SAMPLES = 48000, 480
MAX_LEASE_NS = 10_000_000_000


async def watch_lease(commands, initial_deadline):
    deadline = 0
    raw = initial_deadline
    while raw:
        now = time.monotonic_ns()
        updated = int(raw)
        if (deadline and now >= deadline) or not 0 < updated - now <= MAX_LEASE_NS:
            return
        deadline = updated
        try:
            raw = await asyncio.wait_for(commands.readline(), (deadline - now) / 1e9)
        except TimeoutError:
            return


async def capture(args, frame_size, send):
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-nostdin", "-loglevel", "quiet", "-filter_threads", "1", *args,
        "-threads", "1", "-flush_packets", "1", "pipe:1",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        while True:
            await send(await process.stdout.readexactly(frame_size))
    finally:
        if process.returncode is None:
            process.kill()
        # A full stdout pipe can postpone wait() even after the process exits.
        await process.communicate()


async def publish(room, settings, disconnected):
    await room.connect(settings["livekitUrl"], settings["token"], rtc.RoomOptions(auto_subscribe=False))
    video = rtc.VideoSource(WIDTH, HEIGHT)
    audio = rtc.AudioSource(SAMPLE_RATE, 1, queue_size_ms=100)
    video_track = rtc.LocalVideoTrack.create_video_track("remote-browser-viewport", video)
    audio_track = rtc.LocalAudioTrack.create_audio_track("remote-browser-audio", audio)
    video_publication = await room.local_participant.publish_track(video_track, rtc.TrackPublishOptions(
        source=rtc.TrackSource.SOURCE_SCREENSHARE, simulcast=False,
    ))
    audio_publication = await room.local_participant.publish_track(audio_track, rtc.TrackPublishOptions(
        source=rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO,
    ))
    first_video, first_audio = asyncio.Event(), asyncio.Event()

    async def send_video(raw):
        video.capture_frame(rtc.VideoFrame(WIDTH, HEIGHT, rtc.VideoBufferType.I420, raw))
        first_video.set()

    async def send_audio(raw):
        await audio.capture_frame(rtc.AudioFrame(raw, SAMPLE_RATE, 1, AUDIO_SAMPLES))
        first_audio.set()

    async def ready():
        await first_video.wait()
        await first_audio.wait()
        print(json.dumps({"videoTrackSid": video_publication.sid, "audioTrackSid": audio_publication.sid}), flush=True)
        await disconnected.wait()
        raise RuntimeError("disconnected")

    async with asyncio.TaskGroup() as tasks:
        tasks.create_task(capture([
            "-f", "x11grab", "-draw_mouse", "0", "-framerate", str(FPS),
            "-video_size", f"{WIDTH}x{HEIGHT}", "-i", settings["display"],
            "-pix_fmt", "yuv420p", "-f", "rawvideo",
        ], WIDTH * HEIGHT * 3 // 2, send_video))
        tasks.create_task(capture([
            "-f", "pulse", "-sample_rate", str(SAMPLE_RATE), "-channels", "1", "-fragment_size", "960",
            "-i", "vrata_browser.monitor", "-f", "s16le",
        ], AUDIO_SAMPLES * 2, send_audio))
        tasks.create_task(ready())


async def main():
    loop = asyncio.get_running_loop()
    commands = asyncio.StreamReader(limit=16384)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(commands), sys.stdin.buffer)
    settings = json.loads(await asyncio.wait_for(commands.readline(), 2))
    room = rtc.Room()
    disconnected = asyncio.Event()
    room.on("disconnected", lambda *_: disconnected.set())
    lease = asyncio.create_task(watch_lease(commands, settings["deadline"]))
    # Validate the initial deadline before making a network connection.
    await asyncio.sleep(0)
    if lease.done():
        await lease
        return
    publication = asyncio.create_task(publish(room, settings, disconnected))
    try:
        done, _ = await asyncio.wait((lease, publication), return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            await task
    finally:
        publication.cancel()
        lease.cancel()
        # Retire the publication without waiting for the capture subprocesses
        # to finish. None of their queues may keep a participant publishing.
        try:
            await asyncio.wait_for(room.disconnect(), 0.4)
        finally:
            await asyncio.gather(publication, lease, return_exceptions=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        # SDK exceptions and commands may contain credentials and network URLs.
        sys.exit(1)
