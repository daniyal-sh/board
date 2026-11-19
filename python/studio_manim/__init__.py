"""Studio helpers for Manim Community.

``StudioScene`` is a drop-in replacement for ``Scene`` that

* records every ``play``/``wait`` (start, end, source line, a readable label) and the
  on-screen box of every named mobject after each step, written to the JSON file named by
  the ``STUDIO_TIMELINE_OUT`` environment variable. The app uses it for the timeline and
  for click-to-edit;
* syncs to narration: ``self.wait_until("mark")`` waits until the narration reaches a mark.
  Mark times come from the JSON file named by ``STUDIO_NARRATION`` (``{"audio": path,
  "marks": {"name": seconds}}``). Without narration it waits a short default.
"""

from __future__ import annotations

import inspect
import json
import os
from typing import Any

from manim import DL, UR, Animation, Mobject, Scene, config

__all__ = ["StudioScene"]

_DEFAULT_MARK_WAIT = 0.5


def _named_mobjects(frame: Any) -> dict[int, tuple[str, Mobject]]:
    """Map id(mobject) -> (variable name, mobject) for locals and self attributes in the caller."""
    found: dict[int, tuple[str, Mobject]] = {}
    if frame is None:
        return found
    for name, value in frame.f_locals.items():
        if name.startswith("_") or name == "self":
            continue
        if isinstance(value, Mobject):
            found.setdefault(id(value), (name, value))
    self_obj = frame.f_locals.get("self")
    if self_obj is not None:
        for name, value in vars(self_obj).items():
            if not name.startswith("_") and isinstance(value, Mobject):
                found.setdefault(id(value), (name, value))
    return found


def _anim_label(anim: Any, names: dict[int, tuple[str, Mobject]]) -> str:
    if isinstance(anim, Animation):
        target = getattr(anim, "mobject", None)
        name = names.get(id(target), (type(target).__name__ if target is not None else "",))[0]
        kind = type(anim).__name__
        if kind == "_MethodAnimation":
            kind = "animate"
        return f"{kind}({name})" if name else kind
    # `mob.animate...` builders before they are converted
    target = getattr(anim, "mobject", None)
    if target is not None and id(target) in names:
        return f"animate({names[id(target)][0]})"
    return type(anim).__name__


class StudioScene(Scene):
    def setup(self) -> None:
        super().setup()
        self._studio_plays: list[dict[str, Any]] = []
        self._studio_parts: dict[str, dict[str, Any]] = {}
        self._studio_marks: dict[str, float] = {}
        narration = os.environ.get("STUDIO_NARRATION")
        if narration and os.path.exists(narration):
            with open(narration, encoding="utf-8") as fh:
                data = json.load(fh)
            self._studio_marks = {k: float(v) for k, v in data.get("marks", {}).items()}
            audio = data.get("audio")
            if audio and os.path.exists(audio):
                self.add_sound(audio)

    # -- timing -------------------------------------------------------------------------

    @property
    def studio_time(self) -> float:
        return float(getattr(self.renderer, "time", 0.0))

    def wait_until(self, mark: str, fallback: float = _DEFAULT_MARK_WAIT) -> None:
        """Wait until the narration reaches ``mark`` (or ``fallback`` seconds without narration)."""
        frame = inspect.currentframe()
        caller = frame.f_back if frame else None
        target = self._studio_marks.get(mark)
        delay = fallback if target is None else max(0.0, target - self.studio_time)
        start = self.studio_time
        if delay > 0:
            self._studio_waiting = True
            try:
                Scene.wait(self, delay)
            finally:
                self._studio_waiting = False
        self._record(caller, start, f"wait for “{mark}”", kind="mark")

    def play(self, *args: Any, **kwargs: Any) -> None:
        # Manim's own wait() calls play(Wait(...)); that is recorded by wait() instead.
        if getattr(self, "_studio_waiting", False):
            super().play(*args, **kwargs)
            return
        frame = inspect.currentframe()
        caller = frame.f_back if frame else None
        start = self.studio_time
        names = _named_mobjects(caller)
        label = ", ".join(_anim_label(a, names) for a in args) or "play"
        super().play(*args, **kwargs)
        self._record(caller, start, label, kind="play", names=names)

    def wait(self, duration: float = 1.0, *args: Any, **kwargs: Any) -> None:
        frame = inspect.currentframe()
        caller = frame.f_back if frame else None
        start = self.studio_time
        self._studio_waiting = True
        try:
            super().wait(duration, *args, **kwargs)
        finally:
            self._studio_waiting = False
        self._record(caller, start, "wait", kind="wait")

    # -- recording ------------------------------------------------------------------------

    def _record(self, caller: Any, start: float, label: str, kind: str, names: dict | None = None) -> None:
        if not hasattr(self, "_studio_plays"):
            return
        end = self.studio_time
        line = caller.f_lineno if caller else None
        self._studio_plays.append({"kind": kind, "label": label, "start": round(start, 3), "end": round(end, 3), "line": line})
        self._snapshot(end, names if names is not None else _named_mobjects(caller), line)

    def _snapshot(self, t: float, names: dict[int, tuple[str, Mobject]], line: int | None) -> None:
        on_stage = {id(m) for m in self.get_mobject_family_members()}
        fw, fh = config.frame_width, config.frame_height
        for mid, (name, mob) in names.items():
            if mid not in on_stage or not mob.has_points() and not mob.submobjects:
                continue
            try:
                x0, y0 = mob.get_corner(DL)[:2]
                x1, y1 = mob.get_corner(UR)[:2]
            except Exception:  # noqa: BLE001 - some mobjects have no extent
                continue
            part = self._studio_parts.setdefault(name, {"name": name, "type": type(mob).__name__, "line": line, "boxes": []})
            part["boxes"].append(
                {
                    "t": round(t, 3),
                    "x0": round((x0 + fw / 2) / fw, 4),
                    "y0": round((fh / 2 - y1) / fh, 4),
                    "x1": round((x1 + fw / 2) / fw, 4),
                    "y1": round((fh / 2 - y0) / fh, 4),
                }
            )

    def tear_down(self) -> None:
        super().tear_down()
        out = os.environ.get("STUDIO_TIMELINE_OUT")
        if not out or not hasattr(self, "_studio_plays"):
            return
        data = {
            "scene": type(self).__name__,
            "duration": round(self.studio_time, 3),
            "marks": self._studio_marks,
            "plays": self._studio_plays,
            "parts": list(self._studio_parts.values()),
        }
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1)
