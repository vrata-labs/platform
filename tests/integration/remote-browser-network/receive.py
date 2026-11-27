"""Test subscriber, without publish permissions or access to the capture sockets."""

import asyncio
from collections import deque
import json
import sys
import time

import numpy as np
from livekit import rtc


class Receiver:
    def __init__(self):
        self.room = rtc.Room()
        self.samples = {}
        self.tasks = set()
        self.room.on("track_subscribed", self.subscribed)

    def subscribed(self, track, publication, participant):
        samples = self.samples.setdefault(participant.identity, {"audio": deque(maxlen=80), "video": deque(maxlen=20)})

        async def capture():
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                async for item in rtc.AudioStream(track, sample_rate=48000, num_channels=1):
                    samples["audio"].append((time.monotonic(), bytes(item.frame.data)))
            elif track.kind == rtc.TrackKind.KIND_VIDEO:
                async for item in rtc.VideoStream(track, format=rtc.VideoBufferType.RGB24):
                    frame = item.frame
                    data = np.frombuffer(frame.data, dtype=np.uint8).reshape(frame.height, frame.width, 3)
                    samples["video"].append((time.monotonic(), [
                        data[frame.height // 4, frame.width // 4].tolist(),
                        data[frame.height // 2, frame.width // 2].tolist(),
                    ]))

        task = asyncio.create_task(capture())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def report(self):
        oldest = time.monotonic() - 1.25
        return {
            "participants": list(self.room.remote_participants),
            "samples": {
                identity: {"frequency": frequency(samples["audio"], oldest),
                           "pixels": [pixels for when, pixels in samples["video"] if when > oldest]}
                for identity, samples in self.samples.items()
            },
        }


def frequency(samples, oldest):
    data = np.frombuffer(b"".join(sample for when, sample in samples if when > oldest), dtype=np.int16)
    if len(data) < 4800 or np.max(np.abs(data.astype(np.int32))) < 200:
        return 0
    spectrum = np.abs(np.fft.rfft(data * np.hanning(len(data))))
    return int(np.argmax(spectrum) * 48000 / len(data))


async def main():
    commands = asyncio.StreamReader()
    await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(commands), sys.stdin.buffer)
    tokens = json.loads(await commands.readline())
    receivers = [Receiver() for _ in tokens]
    await asyncio.gather(*(receiver.room.connect("ws://fixture-livekit:7880", token) for receiver, token in zip(receivers, tokens)))
    print(json.dumps({"ready": True}), flush=True)
    while await commands.readline():
        print(json.dumps([receiver.report() for receiver in receivers]), flush=True)
    await asyncio.gather(*(receiver.room.disconnect() for receiver in receivers))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        sys.exit(1)
