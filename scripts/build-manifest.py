#!/usr/bin/env python3
"""Build or verify manifest.json for Kent's built-in updater.

The manifest is the only release channel: version, notes, the exact files an
update owns, and a SHA-256 for each. Clients verify every byte before writing
anything, so a stale manifest must never be committed.

    python3 scripts/build-manifest.py --version 1.0.0 --notes "What changed"
    python3 scripts/build-manifest.py --check

Hashes are over UTF-8 text with LF line endings, matching what GitHub serves
and what the updater reads through fetch() and readTextFile().
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "manifest.json"

# The bootstrap mod is deliberately absent: an update must never overwrite the
# updater that performs it.
MANAGED = [
    "layouts/kent.json",
    "layouts/kent.svg",
    "mods/kent/main.js",
    "mods/kent/mod.json",
    "mods/kent/icon-chip.js",
    "mods/kent/icon-metrics.js",
    "mods/kent/update-check.js",
    "mods/kent-agents/main.js",
    "mods/kent-agents/mod.json",
    "mods/kent-agents/icon-chip.js",
    "mods/kent-agents/icon-metrics.js",
]
EXCLUDED_PREFIXES = ("mods/kent-updater/",)


def canonical_bytes(path: Path) -> bytes:
    return path.read_bytes().decode("utf-8-sig").replace("\r\n", "\n").encode("utf-8")


def file_entry(path: str) -> dict:
    data = canonical_bytes(ROOT / path)
    return {
        "path": path,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
    }


def managed_path(path: str) -> bool:
    if path.startswith(EXCLUDED_PREFIXES):
        return False
    return path.startswith("layouts/") or path.startswith("mods/kent/") or path.startswith("mods/kent-agents/")


def read_manifest() -> dict:
    try:
        value = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise SystemExit(f"build-manifest: manifest.json is invalid: {exc}")
    if not isinstance(value, dict):
        raise SystemExit("build-manifest: manifest.json is not an object")
    return value


def build(args, existing: dict) -> dict:
    missing = [path for path in MANAGED if not (ROOT / path).is_file()]
    if missing:
        raise SystemExit("build-manifest: missing managed files:\n  " + "\n  ".join(missing))
    try:
        json.loads((ROOT / "layouts" / "kent.json").read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"build-manifest: layouts/kent.json is invalid: {exc}")

    entries = [file_entry(path) for path in sorted(MANAGED)]
    old_paths = {
        entry.get("path")
        for entry in existing.get("files", [])
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    deleted = sorted(path for path in old_paths - set(MANAGED) if managed_path(path))

    return {
        "version": args.version if args.version is not None else existing.get("version", "0.0.0"),
        "channel": args.channel if args.channel is not None else existing.get("channel", "stable"),
        "minHerdr": args.min_herdr if args.min_herdr is not None else existing.get("minHerdr", "0.1.18"),
        "notes": args.notes if args.notes is not None else existing.get("notes", ""),
        "files": entries,
        "deleted": deleted,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build or verify manifest.json.")
    parser.add_argument("--version", help="release version to write (semver)")
    parser.add_argument("--notes", help="one-line what's-new text")
    parser.add_argument("--channel", help="channel name, default stable")
    parser.add_argument("--min-herdr", help="minimum Herdr version")
    parser.add_argument("--check", action="store_true", help="fail when manifest.json does not match the files")
    parser.add_argument("--print-version", action="store_true", help="print the current manifest version")
    args = parser.parse_args()

    existing = read_manifest()
    if args.print_version:
        print(existing.get("version", "0.0.0"))
        return 0

    if args.check:
        if not MANIFEST.exists():
            print("build-manifest: manifest.json is missing", file=sys.stderr)
            return 1
        wanted_entries = [file_entry(path) for path in sorted(MANAGED)]
        wanted_deleted = sorted(
            path
            for path in {
                entry.get("path")
                for entry in existing.get("files", [])
                if isinstance(entry, dict) and isinstance(entry.get("path"), str)
            } - set(MANAGED)
            if managed_path(path)
        )
        problems = []
        if existing.get("files") != wanted_entries:
            problems.append("files/hashes are stale; run python3 scripts/build-manifest.py")
        if existing.get("deleted", []) != wanted_deleted:
            problems.append("deleted is stale; run python3 scripts/build-manifest.py")
        if problems:
            for problem in problems:
                print(f"build-manifest: {problem}", file=sys.stderr)
            return 1
        print("manifest check passed")
        return 0

    manifest = build(args, existing)
    try:
        text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"build-manifest: cannot encode manifest: {exc}")
    MANIFEST.write_text(text, encoding="utf-8")
    print(f"wrote manifest.json: v{manifest['version']}, {len(manifest['files'])} files, {len(manifest['deleted'])} deleted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
