#!/bin/sh
# Install Kent into a Herdr home: the layout, its thumbnail and the two mods, then
# check that both mods load from there. Herdr reloads changed layouts and mods in
# place, so a running window picks the new files up without a restart.
#
#   scripts/install.sh               ~/.config/herdr-app, or $HERDR_APP_HOME when set
#   scripts/install.sh <herdr-home>  that directory instead
#
# keys.json is not touched: Herdr's own bindings live in that one file, so the
# optional layout:kent section is merged in by hand (see the README).
# A file that is about to be replaced is copied first to
# <herdr-home>/kent-backup-<time>/, at the same relative path.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
home=${1:-${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}}
backup="$home/kent-backup-$(date +%Y%m%d-%H%M%S)"

if [ -e "$home" ] && [ ! -d "$home" ]; then
  echo "install.sh: $home is not a directory" >&2
  exit 1
fi
# A typo in the path must not scatter files: a Herdr home is empty, or new, or
# already holds Herdr's own files.
if [ -d "$home" ] && [ -n "$(ls -A "$home")" ] && [ ! -f "$home/herdr.d.ts" ] \
  && ! { [ -d "$home/layouts" ] && [ -d "$home/mods" ]; }; then
  echo "install.sh: $home does not look like a Herdr home (no herdr.d.ts, layouts/ or mods/)" >&2
  echo "install.sh: pass the right directory: scripts/install.sh <herdr-home>" >&2
  exit 1
fi

# put <file in this repository> <path under the Herdr home>
put() {
  dst=$home/$2
  if [ -e "$dst" ] && ! cmp -s "$root/$1" "$dst"; then
    mkdir -p "$backup/$(dirname -- "$2")"
    cp -p "$dst" "$backup/$2"
  fi
  mkdir -p "$(dirname -- "$dst")"
  cp "$root/$1" "$dst"
  printf '  %s\n' "$2"
}

echo "Installing Kent into $home"
put layouts/kent.json layouts/kent.json
[ -f "$root/layouts/kent.svg" ] && put layouts/kent.svg layouts/kent.svg
for mod in kent kent-agents; do
  for file in main.js mod.json icon-chip.js icon-metrics.js; do
    put "mods/$mod/$file" "mods/$mod/$file"
  done
done
if [ -d "$backup" ]; then
  echo "Replaced files are kept in $backup"
fi

if command -v herdr-app >/dev/null 2>&1; then
  herdr-app check "$home/mods/kent"
  herdr-app check "$home/mods/kent-agents"
else
  echo "herdr-app is not on PATH; run these to check the installed mods:"
  echo "  herdr-app check \"$home/mods/kent\""
  echo "  herdr-app check \"$home/mods/kent-agents\""
fi

if [ -f "$home/keys.json" ] && ! grep -q '"layout:kent"' "$home/keys.json"; then
  echo "keys.json here has no layout:kent section: the optional keys in this repository's"
  echo "keys.json are merged in by hand (README, \"Optional keys\")."
fi
echo "To show Kent:  herdr-app do layout.switch '{\"name\":\"kent\"}'"
