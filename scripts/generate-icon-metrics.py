#!/usr/bin/env python3
"""Regenerate mods/*/icon-metrics.js from Herdr's shipped SVG icons.

Run from anywhere with:

    uv run --with svgpathtools python scripts/generate-icon-metrics.py

The generated metrics describe the visible vector bounds inside each SVG
viewport. Kent uses them to shape icon backing without stretching artwork.
"""

from pathlib import Path
import argparse
import os
import re
import sys
import xml.etree.ElementTree as ET

from svgpathtools import parse_path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ICONS = Path(os.environ.get("HERDR_APP_HOME") or (Path.home() / ".config" / "herdr-app")) / "icons"
TARGETS = [ROOT / "mods" / "kent" / "icon-metrics.js", ROOT / "mods" / "kent-agents" / "icon-metrics.js"]
SHAPES = {"path", "rect", "circle", "ellipse", "polygon", "polyline", "line"}
# Containers whose children are never drawn where they sit: templates,
# clip geometry and masks must not pollute the visible bounds.
SKIP_CONTAINERS = {"defs", "clipPath", "mask", "symbol", "pattern"}


def number(value):
    match = re.match(r"[-+0-9.eE]+", str(value or "0"))
    return float(match.group()) if match else 0.0


def shape_boxes(path):
    root = ET.parse(path).getroot()
    viewbox = (root.attrib.get("viewBox") or root.attrib.get("viewbox") or "").replace(",", " ").split()
    if len(viewbox) >= 4:
        vx, vy, vw, vh = map(float, viewbox[:4])
    else:
        vx = vy = 0.0
        vw = number(root.attrib.get("width")) or 24.0
        vh = number(root.attrib.get("height")) or 24.0

    boxes = []
    count = {"stroked": 0, "filled": 0, "transforms": 0}

    def walk(el, inherited_fill, inherited_stroke):
        tag = el.tag.split("}")[-1]
        if tag in SKIP_CONTAINERS:
            return
        # Presentation attributes inherit down the tree, so a <g fill=...>
        # decides for its shapes unless they say otherwise.
        fill = el.attrib.get("fill", inherited_fill).strip().lower()
        stroke = el.attrib.get("stroke", inherited_stroke).strip().lower()
        if "transform" in el.attrib:
            count["transforms"] += 1
        if tag in SHAPES:
            if stroke and stroke != "none" and fill in ("", "none"):
                count["stroked"] += 1
            else:
                count["filled"] += 1
            try:
                if tag == "path" and el.attrib.get("d"):
                    xa, xb, ya, yb = parse_path(el.attrib["d"]).bbox()
                    boxes.append((float(xa), float(ya), float(xb), float(yb)))
                elif tag == "rect":
                    x, y = number(el.attrib.get("x")), number(el.attrib.get("y"))
                    w, h = number(el.attrib.get("width")), number(el.attrib.get("height"))
                    if w and h:
                        boxes.append((x, y, x + w, y + h))
                elif tag == "circle":
                    cx, cy, r = number(el.attrib.get("cx")), number(el.attrib.get("cy")), number(el.attrib.get("r"))
                    if r:
                        boxes.append((cx - r, cy - r, cx + r, cy + r))
                elif tag == "ellipse":
                    cx, cy = number(el.attrib.get("cx")), number(el.attrib.get("cy"))
                    rx, ry = number(el.attrib.get("rx")), number(el.attrib.get("ry"))
                    if rx and ry:
                        boxes.append((cx - rx, cy - ry, cx + rx, cy + ry))
                elif tag in ("polygon", "polyline"):
                    points = [float(x) for x in re.split(r"[\s,]+", el.attrib.get("points", "").strip()) if x]
                    xs, ys = points[0::2], points[1::2]
                    if xs and ys:
                        boxes.append((min(xs), min(ys), max(xs), max(ys)))
                elif tag == "line":
                    x1, y1 = number(el.attrib.get("x1")), number(el.attrib.get("y1"))
                    x2, y2 = number(el.attrib.get("x2")), number(el.attrib.get("y2"))
                    if x1 != x2 or y1 != y2:
                        boxes.append((min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)))
            except Exception:
                pass
        for child in el:
            walk(child, fill, stroke)

    walk(root, root.attrib.get("fill", ""), root.attrib.get("stroke", ""))
    stroked, filled = count["stroked"], count["filled"]
    if count["transforms"]:
        print(f"generate-icon-metrics: warning: {path.name} uses transform on {count['transforms']} element(s); "
              "transforms are not applied to the measured bounds, please review them by hand", file=sys.stderr)

    # Off-viewport sprite content is clipped when rendered; it must not affect
    # the visible bounds. prime-agent.svg is the current example.
    boxes = [(max(x0, vx), max(y0, vy), min(x1, vx + vw), min(y1, vy + vh)) for x0, y0, x1, y1 in boxes]
    boxes = [box for box in boxes if box[2] >= box[0] and box[3] >= box[1] and (box[2] > box[0] or box[3] > box[1])]
    if not boxes or not vw or not vh:
        return None

    x0 = min(box[0] for box in boxes)
    y0 = min(box[1] for box in boxes)
    x1 = max(box[2] for box in boxes)
    y1 = max(box[3] for box in boxes)
    bw, bh = max(0.001, x1 - x0), max(0.001, y1 - y0)
    stroke_only = stroked > 0 and filled == 0

    # visual aspect, viewBox aspect, visible width fraction, visible height
    # fraction, visible center x/y in viewport coordinates, stroke-only flag
    return [
        round(bw / bh, 3),
        round(vw / vh, 3),
        round(bw / vw, 3),
        round(bh / vh, 3),
        round(((x0 + x1) / 2 - vx) / vw, 3),
        round(((y0 + y1) / 2 - vy) / vh, 3),
        1 if stroke_only else 0,
    ]


def main():
    parser = argparse.ArgumentParser(description="Regenerate mods/*/icon-metrics.js from Herdr's shipped SVG icons.")
    parser.add_argument("--icons", type=Path, default=DEFAULT_ICONS, help="directory containing shipped SVG icons")
    args = parser.parse_args()
    icons_dir = args.icons
    if not icons_dir.is_dir():
        print(f"generate-icon-metrics: icons directory not found: {icons_dir}", file=sys.stderr)
        return 1

    metrics = {}
    for path in sorted(icons_dir.glob("*.svg")):
        metric = shape_boxes(path)
        if metric:
            metrics[path.name] = metric

    if not metrics:
        print(f"generate-icon-metrics: no SVG icon metrics found in {icons_dir}", file=sys.stderr)
        return 1

    lines = [
        "// Generated by scripts/generate-icon-metrics.py; do not edit by hand.",
        "// [visual aspect, viewBox aspect, visible width, visible height, center x, center y, stroke-only]",
        "export const ICON_METRICS = {",
    ]
    lines += [f'  "{name}": [{", ".join(str(value) for value in metric)}],' for name, metric in metrics.items()]
    lines += ["};", ""]
    output = "\n".join(lines)
    for target in TARGETS:
        target.write_text(output, encoding="utf-8")
    print(f"wrote {len(metrics)} icon metrics to {len(TARGETS)} mods")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
