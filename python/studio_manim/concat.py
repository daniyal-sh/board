"""Join rendered scene videos (same codec and size) into one MP4 without re-encoding.

Usage: python -m studio_manim.concat <out.mp4> <in1.mp4> [in2.mp4 ...]
"""

from __future__ import annotations

import sys

import av


def main() -> None:
    out_path, *inputs = sys.argv[1:]
    if not inputs:
        raise SystemExit("no inputs")
    out = av.open(out_path, "w")
    with av.open(inputs[0]) as first:
        v_out = out.add_stream_from_template(first.streams.video[0])
    # Narration may exist only for some scenes: take the audio format from the first that has it.
    a_out = None
    for path in inputs:
        with av.open(path) as src:
            if src.streams.audio:
                a_out = out.add_stream_from_template(src.streams.audio[0])
                break

    offset = {"video": 0.0, "audio": 0.0}
    for path in inputs:
        with av.open(path) as src:
            longest = 0.0
            for packet in src.demux():
                if packet.dts is None:
                    continue
                kind = packet.stream.type
                target = v_out if kind == "video" else a_out if kind == "audio" else None
                if target is None:
                    continue
                tb = packet.stream.time_base
                shift = int(offset[kind] / tb)
                packet.pts = (packet.pts or 0) + shift
                packet.dts = packet.dts + shift
                end = float((packet.pts + (packet.duration or 0)) * tb)
                longest = max(longest, end)
                packet.stream = target
                out.mux(packet)
            # Advance both clocks to the end of this clip so audio and video stay aligned.
            offset["video"] = offset["audio"] = longest
    out.close()


if __name__ == "__main__":
    main()
