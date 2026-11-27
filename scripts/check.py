#!/usr/bin/env python3
"""Check that the shared copies inside mods/kent and mods/kent-agents match.

Herdr installs each mod from its own directory, so both mods keep their own
copy of icon-chip.js and icon-metrics.js. icon-metrics.js is regenerated into
both places at once; icon-chip.js is maintained by hand and can drift. This
script fails when the pairs differ, validates the JSON files and the manifest, and runs
`herdr-app check` on disposable copies of all mods when the binary is
available. The copies keep Herdr's generated editor files out of the repository.

Run from anywhere with:

    python3 scripts/check.py           # verify
    python3 scripts/check.py --sync    # copy mods/kent/icon-chip.js over the kent-agents one
"""

from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PAIRS = [
    ("icon-chip.js", ROOT / "mods" / "kent" / "icon-chip.js", ROOT / "mods" / "kent-agents" / "icon-chip.js"),
    ("icon-metrics.js", ROOT / "mods" / "kent" / "icon-metrics.js", ROOT / "mods" / "kent-agents" / "icon-metrics.js"),
]
JSON_FILES = [
    ROOT / "layouts" / "kent.json",
    ROOT / "keys.json",
    ROOT / "manifest.json",
    ROOT / "mods" / "kent" / "mod.json",
    ROOT / "mods" / "kent-agents" / "mod.json",
    ROOT / "mods" / "kent-updater" / "mod.json",
]
# Editor support files Herdr generates and .gitignore keeps out of the repository,
# so a fresh clone has none: validate them when present, never require them.
GENERATED_JSON = [
    ROOT / "mods" / "kent" / "jsconfig.json",
    ROOT / "mods" / "kent-agents" / "jsconfig.json",
]
MODS = ["kent", "kent-agents", "kent-updater"]


def check_pairs():
    problems = []
    for name, source, copy in PAIRS:
        if not source.exists() or not copy.exists():
            problems.append(f"{name}: missing ({source if not source.exists() else copy})")
        elif source.read_bytes() != copy.read_bytes():
            hint = (
                "sync with: python3 scripts/check.py --sync"
                if name == "icon-chip.js"
                else "regenerate with: uv run --with svgpathtools python scripts/generate-icon-metrics.py"
            )
            problems.append(f"{name}: {source.relative_to(ROOT)} and {copy.relative_to(ROOT)} differ ({hint})")
    return problems


def invalid_json(path):
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"{path.relative_to(ROOT)}: invalid JSON: {exc}"]
    return []


def check_manifest():
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build-manifest.py"), "--check"],
        text=True,
        capture_output=True,
    )
    if result.returncode == 0:
        return []
    return [f"manifest.json: {(result.stdout or result.stderr).strip()}"]


def check_json():
    problems = []
    for path in JSON_FILES:
        if not path.exists():
            problems.append(f"{path.relative_to(ROOT)}: missing")
            continue
        problems += invalid_json(path)
    for path in GENERATED_JSON:
        if path.exists():
            problems += invalid_json(path)
    return problems


def check_mods():
    problems = []
    binary = shutil.which("herdr-app")
    if not binary:
        print("check: herdr-app not on PATH; skipping mod checks")
        return problems
    # Even `herdr-app check` can otherwise share the person's running default
    # core through the app holder. Keep the one-shot check in a disposable app
    # home and core session so verifying Kent never disturbs the live window.
    # Check a copy of each mod too: herdr-app writes jsconfig.json and
    # gpui-kit.d.ts beside the mod it loads, and those must not land in the repo.
    env = os.environ.copy()
    with tempfile.TemporaryDirectory(prefix="kent-check-") as tmp:
        env["HERDR_APP_HOME"] = tmp
        env["HC_SESSION"] = f"kent-check-{os.getpid()}"
        mods_root = Path(tmp) / "mods"
        mods_root.mkdir()
        try:
            for mod in MODS:
                target = mods_root / mod
                shutil.copytree(
                    ROOT / "mods" / mod,
                    target,
                    ignore=shutil.ignore_patterns("jsconfig.json", "gpui-kit.d.ts"),
                )
                result = subprocess.run([binary, "check", str(target)], text=True, capture_output=True, env=env)
                if result.returncode != 0:
                    problems.append(f"herdr-app check mods/{mod} failed: {(result.stdout or result.stderr).strip()}")
        finally:
            hc = shutil.which("hc")
            if hc:
                try:
                    subprocess.run([hc, "server", "stop"], text=True, capture_output=True, env=env, timeout=10)
                except (OSError, subprocess.TimeoutExpired):
                    pass
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

    problems = check_pairs() + check_json() + check_manifest()
    if not args.no_herdr:
        problems += check_mods()
    if problems:
        for problem in problems:
            print(f"check: {problem}", file=sys.stderr)
        return 1
    print("check passed: shared copies in sync, JSON and manifest valid" + (", mods load" if not args.no_herdr and shutil.which("herdr-app") else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
