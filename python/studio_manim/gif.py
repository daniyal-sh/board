"""Turn an MP4 into a looping GIF (for slides, LMS pages and chats that don't play video).

Usage: python -m studio_manim.gif <in.mp4> <out.gif> <width> <fps>

Frames are sampled at <fps>, scaled to <width> and given one shared palette (taken from a
spread of frames), which keeps Manim's flat colours steady instead of flickering frame to frame.
"""

from __future__ import annotations

import sys

import av
from PIL import Image


def main() -> None:
    src, out, width, fps = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
    frames: list[Image.Image] = []
    step = 1.0 / fps
    next_t = 0.0
    with av.open(src) as container:
        stream = container.streams.video[0]
        for frame in container.decode(stream):
            t = float(frame.pts * stream.time_base) if frame.pts is not None else next_t
            if t + 1e-6 < next_t:
                continue
            next_t += step
            img = frame.to_image()
            height = round(img.height * width / img.width / 2) * 2
            frames.append(img.resize((width, height), Image.LANCZOS))
    if not frames:
        raise SystemExit("The video has no frames")

    # One palette for the whole GIF, built from up to 12 frames across the video.
    pick = frames[:: max(1, len(frames) // 12)][:12]
    sheet = Image.new("RGB", (frames[0].width, frames[0].height * len(pick)))
    for i, f in enumerate(pick):
        sheet.paste(f, (0, i * f.height))
    palette = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    quantized = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]

    quantized[0].save(
        out,
        save_all=True,
        append_images=quantized[1:],
        duration=round(1000 / fps),
        loop=0,
        optimize=False,
        disposal=1,
    )
    print(len(frames))


if __name__ == "__main__":
    main()
