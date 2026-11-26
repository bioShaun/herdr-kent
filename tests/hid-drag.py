#!/usr/bin/env python3
"""Drive the real pointer over Kent's sidebar and read what the list did.

A mod only sees real mouse events, so the checks here post HID-level events
(CGEventPost to the HID tap): the pointer really moves, the button really goes
down and up, and a drag really is a drag. That needs Accessibility permission
for the process that owns the window - Herdr Core - in System Settings >
Privacy & Security > Accessibility.

Run it with pyobjc and Pillow through uv:

    uv run --with pyobjc-framework-Quartz --with pillow python tests/hid-drag.py drag --from-y 263 --to-y 294
    uv run --with pyobjc-framework-Quartz --with pillow python tests/hid-drag.py scan-edge --ys 700,730,745,770,800
    uv run --with pyobjc-framework-Quartz --with pillow python tests/hid-drag.py click --at 251,213

`scan-edge` is the check for the drag-to-scroll band: for each y it puts the
list back at the top, presses a row, drags to that y, holds, and reports
whether rows inside the crop band moved. A band that starts too far below the
rows you can see is exactly the bug the viewport height fixed.

Coordinates are window pixels; the window is found by name, so moving it is
fine. The crop band defaults to a strip of rows that stays in view for both the
top and the scrolled state; widen it with --crop-top/--crop-bottom when the
window is much taller.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

import Quartz  # pyobjc-framework-Quartz
from PIL import Image, ImageChops

HOME = os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")


def window():
    """The front window called Herdr, as (x, y, width, height) in screen points."""
    found = []
    for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID):
        if (w.get("kCGWindowOwnerName") or "") != "Herdr":
            continue
        b = w.get("kCGWindowBounds") or {}
        if b.get("Width", 0) > 400 and b.get("Height", 0) > 300:
            found.append((b["X"], b["Y"], b["Width"], b["Height"]))
    if not found:
        sys.exit("no Herdr window on screen: open it first")
    return max(found, key=lambda b: b[2] * b[3])


def sidebar_width():
    try:
        with open(os.path.join(HOME, "shared.json")) as f:
            return float(json.load(f).get("sidebar.width") or 268)
    except (OSError, ValueError):
        return 268.0


class Pointer:
    def __init__(self, win):
        self.win = win

    def at(self, x, y):
        return (self.win[0] + x, self.win[1] + y)

    def _post(self, kind, x, y):
        e = Quartz.CGEventCreateMouseEvent(None, kind, self.at(x, y), Quartz.kCGMouseButtonLeft)
        Quartz.CGEventSetIntegerValueField(e, Quartz.kCGMouseEventClickState, 1)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)

    def move(self, x, y, wait=0.12):
        self._post(Quartz.kCGEventMouseMoved, x, y)
        time.sleep(wait)

    def down(self, x, y):
        self._post(Quartz.kCGEventLeftMouseDown, x, y)
        time.sleep(0.2)

    def drag(self, x, y, wait=0.12):
        self._post(Quartz.kCGEventLeftMouseDragged, x, y)
        time.sleep(wait)

    def up(self, x, y):
        self._post(Quartz.kCGEventLeftMouseUp, x, y)
        time.sleep(0.25)

    def pressed(self):
        return Quartz.CGEventSourceButtonState(Quartz.kCGEventSourceStateCombinedSessionState, Quartz.kCGMouseButtonLeft)

    def wheel(self, lines, x, y):
        e = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, lines)
        Quartz.CGEventSetLocation(e, self.at(x, y))
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)


def shot(path):
    subprocess.run(["herdr-app", "shot", path], capture_output=True)
    return path


def band(path, top, bottom, width):
    return Image.open(path).crop((0, int(top), int(width), int(bottom))).convert("L")


def moved(before, after):
    diff = ImageChops.difference(before, after)
    changed = sum(1 for v in diff.getdata() if v > 8)
    return changed, diff.getbbox()


def scrolled(changed, box):
    """Rows moved, not just one row lit up: a scroll shifts the whole band."""
    return changed > 2500 and box is not None and box[3] - box[1] > 120


def focus():
    subprocess.run(["open", "-a", "Herdr"])
    time.sleep(0.8)


def cmd_click(p, args):
    x, y = (float(v) for v in args.at.split(","))
    focus()
    p.move(1200, 600)
    p.move(x, y)
    p.down(x, y)
    p.up(x, y)
    print(f"clicked at {x},{y}; button down: {p.pressed()}")


def cmd_drag(p, args):
    width = sidebar_width()
    focus()
    p.move(1200, 600)
    p.move(args.press_x, args.press_y)
    p.down(args.press_x, args.press_y)
    pre = shot(tempfile.mktemp(suffix=".png"))
    try:
        for step in range(1, 6):
            y = args.press_y + (args.to_y - args.press_y) * step / 5
            p.drag(args.to_x, y, wait=0.1)
        time.sleep(args.hold)
        during = shot(tempfile.mktemp(suffix=".png"))
    finally:
        p.drag(width + 120, args.to_y)
        p.up(width + 120, args.to_y)
    changed, box = moved(band(pre, args.crop_top, args.crop_bottom, width), band(during, args.crop_top, args.crop_bottom, width))
    print(f"drag {args.press_y} -> {args.to_y}: {changed} pixels changed, band bbox {box}; button down: {p.pressed()}")


def cmd_scan_edge(p, args):
    width = sidebar_width()
    height = Image.open(shot(tempfile.mktemp(suffix=".png"))).size[1]
    bottom = args.crop_bottom or height * 0.6
    focus()
    print(f"window {p.win[0]:.0f},{p.win[1]:.0f} {p.win[2]:.0f}x{p.win[3]:.0f}; sidebar {width:.0f}; band {args.crop_top:.0f}..{bottom:.0f}")
    for y in [float(v) for v in args.ys.split(",")]:
        p.move(1200, 600)
        p.wheel(args.reset, width / 2, 400)
        time.sleep(0.7)
        pre = shot(tempfile.mktemp(suffix=".png"))
        p.move(args.press_x, args.press_y)
        p.down(args.press_x, args.press_y)
        try:
            p.drag(args.press_x, y, wait=0.1)
            time.sleep(args.hold)
            during = shot(tempfile.mktemp(suffix=".png"))
        finally:
            p.drag(width + 120, y)
            p.up(width + 120, y)
        changed, box = moved(band(pre, args.crop_top, bottom, width), band(during, args.crop_top, bottom, width))
        print(f"y={y:.0f}: {'scrolled' if scrolled(changed, box) else 'no'} ({changed} px, bbox {box})")
    print(f"button down: {p.pressed()}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan-edge", help="does holding a row at each y scroll the list?")
    s.add_argument("--ys", default="700,730,745,770,800", help="window y values to hold at")
    s.add_argument("--hold", type=float, default=1.2, help="seconds to hold at each y")
    s.add_argument("--press-x", type=float, default=100)
    s.add_argument("--press-y", type=float, default=150, help="a row near the top of the list")
    s.add_argument("--reset", type=int, default=120, help="wheel lines back to the top before each try")
    s.add_argument("--crop-top", type=float, default=200)
    s.add_argument("--crop-bottom", type=float, default=0, help="0 = 60%% of the window height")
    s.set_defaults(run=cmd_scan_edge)

    d = sub.add_parser("drag", help="press a row, drag it somewhere, let go")
    d.add_argument("--press-x", type=float, default=100)
    d.add_argument("--press-y", type=float, default=150)
    d.add_argument("--to-x", type=float, default=100)
    d.add_argument("--to-y", type=float, required=True)
    d.add_argument("--hold", type=float, default=0.35)
    d.add_argument("--crop-top", type=float, default=200)
    d.add_argument("--crop-bottom", type=float, default=740)
    d.set_defaults(run=cmd_drag)

    c = sub.add_parser("click", help="a real click at a window position")
    c.add_argument("--at", default="100,150", help="x,y in window pixels")
    c.set_defaults(run=cmd_click)

    args = ap.parse_args()
    p = Pointer(window())
    args.run(p, args)


if __name__ == "__main__":
    main()
