# Kent for Herdr

[中文说明](README.zh-CN.md)

Kent is a Herdr layout for people who keep many spaces open. It keeps Herdr's practical main window, but turns the Spaces sidebar into named, foldable groups inside each machine.

![Kent](preview.png)

## What it does

- Groups spaces under named labels such as `design`, `code`, or `experiments`; unassigned spaces stay in `default`; once named groups are in use, `default` has its own foldable heading.
- Groups are scoped to each machine; remote and local spaces are never mixed.
- Group headers fold and unfold, show member counts, and keep blocked/done status visible while folded.
- Space rows show program icons in theme-aware contrast-edge chips, plus the space name, git repository/branch details, and agent status. Shipped SVG icons are fitted from their visible vector bounds, so tall or wide artwork keeps its direction instead of being stretched into squares.
- Agents use the same icon chips through the included `kent-agents` mod.
- Spaces can be created directly inside a group, assigned from the right-click menu, or dragged onto a group header.
- Spaces can be reordered inside a group, dragged between groups, or moved back to `default`.
- Worktrees stay nested under their checkout, and Herdr's machine/git/space ordering behavior is preserved.
- The compact narrow-sidebar rail still works when the sidebar is very small.

## Install

### From the Herdr Gallery

After the Gallery finishes indexing this repository, open:

<https://herdr.dev/layouts/bioShaun/herdr-kent>

### Manual install

Copy the layout and mod into your Herdr home. If you use a custom `HERDR_APP_HOME`, replace `~/.config/herdr-app` with that directory.

```sh
git clone git@github.com:bioShaun/herdr-kent.git
cd herdr-kent

cp layouts/kent.json layouts/kent.png ~/.config/herdr-app/layouts/
mkdir -p ~/.config/herdr-app/mods/kent ~/.config/herdr-app/mods/kent-agents
cp mods/kent/main.js mods/kent/mod.json mods/kent/icon-chip.js mods/kent/icon-metrics.js ~/.config/herdr-app/mods/kent/
cp mods/kent-agents/main.js mods/kent-agents/mod.json mods/kent-agents/icon-chip.js mods/kent-agents/icon-metrics.js ~/.config/herdr-app/mods/kent-agents/

herdr-app check ~/.config/herdr-app/mods/kent
herdr-app check ~/.config/herdr-app/mods/kent-agents
herdr-app do layout.switch '{"name":"kent"}'
```

Your existing `main` layout is not modified. Use `ctrl-shift-l` / `cmd-shift-l` to cycle layouts, or run:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

## Optional keys

`keys.json` contains optional bindings. Do not replace your whole Herdr `keys.json`; merge the `layout:kent` section into it manually:

```json
{
  "layout:kent": {
    "alt-down": "kent.next",
    "alt-up": "kent.prev",
    "ctrl-shift-pagedown": "kent.next",
    "ctrl-shift-pageup": "kent.prev"
  }
}
```

These move through spaces in the order Kent draws them, skipping rows hidden inside folded groups.

## Using groups

- Right-click a space to open its menu.
- Choose `Group this space…` to create a group containing that space.
- Choose `Move to …` to file the space under an existing group.
- Choose `Move to default` to move it back to the default group.
- Drag a space onto a group header to append it to that group.
- Drag a space over another row to reorder it.
- While dragging a grouped space, use `Move to default` at the bottom of the list to remove it from its named group.
- Click a group header to fold or unfold it; use its `+` button to create a new space inside that group.
- Right-click a named group header to create a space in it, rename, reorder, fold/unfold, or delete it. Deleting a group never closes its spaces.

On git checkouts, the space menu also includes Herdr's worktree actions: `New worktree`, `Open worktree`, and, for linked checkouts, `Remove worktree`.

## Theme behavior

Kent does not hardcode a light or dark theme. It follows `settings.json`, the system appearance, and Herdr's theme picker. Changing appearance or theme should redraw both Spaces and Agents; the icon edge colors invert with the active appearance.

## Notes and limits

- Grouping is manual. Kent does not infer groups from path, prefix, or tags.
- Groups cannot span machines. Same-named groups on two machines are independent.
- Group state is stored per machine in that machine's herdr-core document `kent.groups.v1`. Clients connected to the same machine share group definitions, membership, ordering, and fold state, even when they use different local aliases for that machine; membership is stored as machine-local space ids.
- Writes are optimistic in the window and then written asynchronously with the core document's compare-and-set version. A conflict is reread and the intent is reapplied rather than blindly overwriting the other client's edit. Kent polls about every three seconds while visible, so another client's change can take a few seconds to appear.
- If a machine is offline or its core is too old for document storage, Kent keeps the previous client-local behavior and queues edits locally. Queued intents survive app restarts and retry when the machine and core are available; until then those edits are not visible to other clients.
- Existing client-local groups are migrated once into each machine document. Same-named legacy groups are merged because the old local-only data did not have stable cross-client identities; membership already present in the machine document wins. If several clients had divergent arrangements, review important groups after the first synchronized migration.
- Ordering inside named groups belongs to Kent. Spaces in `default` continue to use Herdr's own ordering.
- Kent was built and tested against Herdr 0.1.18. Cross-client group synchronization requires a herdr-core new enough for machine-scoped documents (validated with 0.1.22); older cores use the client-local fallback.
- Visible-bound metrics are generated for the SVG icons shipped with Herdr 0.1.18. Icons added by a future Herdr version can be measured again with `scripts/generate-icon-metrics.py`; unknown custom icons fall back to square fitting.

## Development

The Spaces mod is in `mods/kent/main.js`; the Agents variant is in `mods/kent-agents/main.js`; the layout tree is `layouts/kent.json`.

Validate the mod from the repository root:

```sh
herdr-app check mods/kent
herdr-app check mods/kent-agents
```

Run the group synchronization unit harness, optionally with an isolated real-core document/CAS test (it uses a temporary `HC_SESSION` and does not touch the default core):

```sh
node scripts/test-group-sync.js
node scripts/test-group-sync.js --core
```

Both mods keep their own copy of `icon-chip.js` and `icon-metrics.js`. After editing either copy, verify the pairs still match (and both mods still load) with the following command. Its `herdr-app check` runs use a temporary isolated app home/core session, so they do not disturb the running default Herdr core:

```sh
python3 scripts/check.py
```

After Herdr updates its shipped icon set, regenerate the icon metrics from the repository root:

```sh
uv run --with svgpathtools python scripts/generate-icon-metrics.py
```

After changing the layout or mods, regenerate the preview from the repository root:

```sh
python3 scripts/generate-preview.py
```

The script starts a temporary isolated Herdr home/core, seeds curated demo spaces and agents, captures a real rendered frame with `herdr-app shot`, writes `preview.png` (and its settings-picker copy `layouts/kent.png`, referenced by the layout's `preview` field), and removes the temporary instance. It does not read or capture your normal Herdr home. Use `--keep` to keep the isolated directory for debugging, or `--output` to write another file.

`RECIPE.md` is the detailed implementation brief used for the Herdr Gallery format.

## License

Apache License 2.0. Kent includes derivatives of Herdr's shipped `spaces` and `agents` mods; see `NOTICE`.
