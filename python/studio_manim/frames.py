"""Extract PNG frames from a video at given times.

Usage: python -m studio_manim.frames <video.mp4> <out_dir> <t1> [t2 ...]
Prints one JSON line: [{"time": t, "path": "..."}].
Uses PyAV (a Manim dependency), so no separate ffmpeg is needed.
"""

from __future__ import annotations

import json
import os
import sys

import av


def main() -> None:
    video, out_dir, *times = sys.argv[1:]
    wanted = sorted(float(t) for t in times)
    os.makedirs(out_dir, exist_ok=True)
    results = []
    with av.open(video) as container:
        stream = container.streams.video[0]
        duration = float(stream.duration * stream.time_base) if stream.duration else None
        last = None
        i = 0
        for frame in container.decode(stream):
            t = float(frame.pts * stream.time_base) if frame.pts is not None else 0.0
            while i < len(wanted) and t >= wanted[i]:
                path = os.path.join(out_dir, f"frame_{wanted[i]:.2f}.png")
                frame.to_image().save(path)
                results.append({"time": wanted[i], "path": path})
                i += 1
            last = frame
            if i >= len(wanted):
                break
        # Times past the end get the last frame.
        while i < len(wanted) and last is not None:
            path = os.path.join(out_dir, f"frame_{wanted[i]:.2f}.png")
            last.to_image().save(path)
            results.append({"time": duration or wanted[i], "path": path})
            i += 1
    print(json.dumps(results))


if __name__ == "__main__":
    main()
