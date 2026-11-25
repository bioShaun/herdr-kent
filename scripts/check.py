#!/usr/bin/env python3
"""Check that the shared copies inside mods/kent and mods/kent-agents match.

Herdr installs each mod from its own directory, so both mods keep their own
copy of icon-chip.js and icon-metrics.js. icon-metrics.js is regenerated into
both places at once; icon-chip.js is maintained by hand and can drift. This
script fails when the pairs differ, validates the JSON files, and runs
`herdr-app check` on both mods when the binary is available.

Run from anywhere with:

    python3 scripts/check.py           # verify
    python3 scripts/check.py --sync    # copy mods/kent/icon-chip.js over the kent-agents one
"""

from pathlib import Path
import argparse
import json
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PAIRS = [
    ("icon-chip.js", ROOT / "mods" / "kent" / "icon-chip.js", ROOT / "mods" / "kent-agents" / "icon-chip.js"),
    ("icon-metrics.js", ROOT / "mods" / "kent" / "icon-metrics.js", ROOT / "mods" / "kent-agents" / "icon-metrics.js"),
]
JSON_FILES = [
    ROOT / "layouts" / "kent.json",
    ROOT / "keys.json",
    ROOT / "mods" / "kent" / "mod.json",
    ROOT / "mods" / "kent" / "jsconfig.json",
    ROOT / "mods" / "kent-agents" / "mod.json",
    ROOT / "mods" / "kent-agents" / "jsconfig.json",
]
MODS = ["kent", "kent-agents"]


def check_pairs():
    problems = []
    for name, source, copy in PAIRS:
        if not source.exists() or not copy.exists():
            problems.append(f"{name}: missing ({source if not source.exists() else copy})")
        elif source.read_bytes() != copy.read_bytes():
            problems.append(f"{name}: mods/kent and mods/kent-agents copies differ (sync with: python3 scripts/check.py --sync)")
    return problems


def check_json():
    problems = []
    for path in JSON_FILES:
        if not path.exists():
            problems.append(f"{path.relative_to(ROOT)}: missing")
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            problems.append(f"{path.relative_to(ROOT)}: invalid JSON: {exc}")
    return problems


def check_mods():
    problems = []
    binary = shutil.which("herdr-app")
    if not binary:
        print("check: herdr-app not on PATH; skipping mod checks")
        return problems
    for mod in MODS:
        result = subprocess.run([binary, "check", str(ROOT / "mods" / mod)], text=True, capture_output=True)
        if result.returncode != 0:
            problems.append(f"herdr-app check mods/{mod} failed: {(result.stdout or result.stderr).strip()}")
    return problems


def sync():
    for name, source, copy in PAIRS:
        if name != "icon-chip.js":
            continue
        shutil.copy2(source, copy)
        print(f"check: copied mods/kent/{name} to mods/kent-agents/{name}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Check the duplicated mod files are in sync.")
    parser.add_argument("--sync", action="store_true", help="copy mods/kent/icon-chip.js over the kent-agents copy")
    parser.add_argument("--no-herdr", action="store_true", help="skip the herdr-app check runs")
    args = parser.parse_args()
    if args.sync:
        return sync()

    problems = check_pairs() + check_json()
    if not args.no_herdr:
        problems += check_mods()
    if problems:
        for problem in problems:
            print(f"check: {problem}", file=sys.stderr)
        return 1
    print("check passed: shared copies in sync, JSON valid" + (", mods load" if not args.no_herdr and shutil.which("herdr-app") else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
