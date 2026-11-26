# Kent

A compact, theme-aware Herdr layout for people who keep many spaces open. Its Spaces sidebar works like a set of labeled shelves: spaces can be filed under named groups such as “design”, “code” and “experiments”, while the rest of the window stays close to Herdr's practical main layout.

![Kent](preview.png)

## What you see

- **The window:** Herdr's main arrangement — sidebar on the left, tab bar over the terminal cards, Files/Changes panel on the right when opened, and a thin status bar.
- **The look:** the person's active Herdr theme. Kent does not pin `theme` or hex `colors`, so Settings, system light/dark appearance, and the theme picker all apply. The preview shows a graphite-like dark theme with a quiet violet accent.
- **The sidebar:** 232px wide by default. The Spaces list receives two shares of the list area and the Agents list one, so a long grouped inventory stays visible while agent status remains close at hand.
- **Machines:** when another machine is known, its spaces stay under that machine's header, as in Herdr. Grouping happens inside each machine, never across machines.
- **A group header:** a 24px dim 11px label with a folder icon, the group name, a count, a quiet new-space button, and a chevron. A folded group that contains a blocked or finished agent shows a small status dot.
- **A space row:** 28px high, with a 20px program-icon chip, the space name, Herdr's usual repo/branch/ahead/behind tail when useful, and a small dot for blocked or done. The active space is a quiet pill in `selected` with a slim accent-colored leading indicator.
- **An icon chip:** a 1px-neutral pseudo-gradient edge, brighter at the top/left and quieter at the bottom/right. The polarity is chosen from the luminance of the actual `chrome` surface, not merely the system appearance: dark chrome uses white alpha (`#ffffff26` → `#ffffff06`); light chrome uses black alpha (`#00000024` → `#00000006`). Inside is the program tile, or a very quiet translucent neutral when the program has no tile, so dark and light program artwork stays readable without being recolored. The backing follows the visible artwork bounds generated for every shipped SVG icon, softly compressed to the 0.625–1.6 range so extreme logos keep their direction without becoming pills. Stroke-only utility icons keep their designed padding; filled artwork is optically centered and fitted. Agents use the same chip.
- **Default group:** spaces without a named group appear after the named groups inside the same machine. When named groups are in use, they sit under a foldable virtual `default` heading. It is presentation-only: membership stays unassigned and their order still comes from Herdr.

## How it behaves

- Click a space to show it. Dragging a space over another row shows the violet insertion line; dropping reorders inside a group or uses Herdr's normal `space.move` behavior for loose spaces.
- Drop a space on a group header to append it to that group. While dragging a grouped space, a “Move to default” target appears at the bottom of the list.
- Right-click a space for a keyboard-navigable menu: Open, Rename — on git checkouts followed by Herdr's New worktree/Open worktree actions, plus Remove worktree on linked checkouts — then Move to default, one “Move to …” item for each named group on that machine, “Group this space…”, and Close space.
- Right-click a named group to create a space in it, fold/unfold, rename, move it up or down, or delete it. Deleting a group never closes spaces; they simply return to `default`.
- Click a group header to fold or unfold it. Its quiet `+` control creates a space directly inside that group; creating into a folded group unfolds it so the new row is visible. The command palette can also open “New space group” and “Group active space”.
- Groups are per machine. Their names, folded state, membership, in-group order and per-machine `default` fold state persist in that machine's herdr-core document `kent.groups.v1`; clients connected to the same machine therefore see the same groups. The window redraws optimistically, writes with compare-and-set retries, and polls while visible for other clients' changes.
- Worktree nesting, machine folding/reconnection, git branch details and the narrow numbered rail are inherited from Herdr's shipped `spaces` mod.
- If `keys.json` is merged, `alt-down` / `alt-up` and `ctrl-shift-pagedown` / `ctrl-shift-pageup` move through spaces in the order Kent draws them, skipping folded rows.

## Built from

- **Layout** `layouts/kent.json`: a copy of Herdr's `main` structure. The sidebar is 232px, the Spaces block uses mod `kent` with weight 2, the Agents block uses `kent-agents` with weight 1. The root divider highlights in `accent` on hover so the drag-to-narrow edge is discoverable, and the Spaces/Agents boundary inside `sidebar-lists` carries a transparent divider that only shows its `accent` hover line. The root sets `"preview": "layouts/kent.png"` so the settings layout picker shows a real thumbnail. The root deliberately leaves `theme` and `colors` unset so the layout follows the person's settings and theme picks.
- **Mod** `mods/kent/`: based on Herdr 0.1.18's shipped `spaces` mod. It keeps the git/worktree/machine logic and adds:
  - the per-machine core-document group store (`groups`, ordered `in` membership arrays), with legacy shared-state migration and fallback,
  - `machineRows` and `groupHead` rendering,
  - program-icon rows using `panes()` and `program.icon` / `image` / `svg`,
  - the generated visible-bound icon metrics and theme-aware pseudo-gradient chip described above,
  - drag assignment and in-group ordering,
  - popup menus, group rename/create dialogs, and palette commands through `nextCommand()`.
- **Mod** `mods/kent-agents/`: a copy of Herdr 0.1.18's shipped `agents` mod, with the program-icon helper replaced by the same chip, its self-opened sort popup renamed to `kent-agents`, and row/header/menu rhythm aligned with the Spaces sidebar.
- **Keys** `keys.json`: optional `layout:kent` bindings for `kent.next` and `kent.prev`.
- **Art:** `preview.png` is regenerated with `python3 scripts/generate-preview.py`; the script captures a real frame from a temporary isolated Herdr home/core seeded with curated demo data, never the person's live window, and copies the result to `layouts/kent.png` for the settings-picker thumbnail. The layout itself uses Herdr's shipped SVG icons and program icons.

## Watch out

- Group membership is manual: Kent does not infer groups from name prefixes, folders or tags. Use the menu or drag and drop.
- Groups cannot span machines. A group with the same name on two machines is two separate groups.
- When a machine is offline or its core does not support documents, Kent falls back to the previous client-local snapshot and keeps edits in a restart-safe pending queue; those edits sync when the machine/core becomes usable. Old client-local groups migrate once, with same-named legacy groups merged because they had no stable cross-client identity.
- Ordering inside a named group belongs to Kent. Spaces in `default` still use Herdr's own space ordering.
- In the narrow rail (sidebar below 160px), group labels collapse away and rows use the compact numbered presentation.
- Icon metrics are pregenerated for the SVGs shipped with Herdr 0.1.18 rather than measured at runtime. `scripts/generate-icon-metrics.py` refreshes them after Herdr adds icons; unknown custom non-square icons still fall back to square fitting.
- The mods open their own overlays as `mod: "kent"` and `mod: "kent-agents"`; renaming either folder means changing those strings and the layout reference together.
- `herdr-app check` intentionally runs with empty live data, so grouping interactions still need a real-window pass.

## Done when

- New groups can be created from the folder-plus button or command palette, including Chinese names.
- A space can be created inside a group, assigned, moved between groups, reordered in a group and returned to `default`; the state survives an app restart and synchronizes through each machine's core document.
- Group headers fold, show the right counts, and keep blocked/done visible while folded.
- The active space is clearly marked by selection and its accent indicator, and rows show the running program's icon rather than avatar letters.
- Multiple machines still have their own headers and cannot accept cross-machine drops.
- `herdr-app check mods/kent` and `herdr-app check mods/kent-agents` pass, and switching to `layouts/kent.json` produces no entry in `herdr-app status` errors.
- `python3 scripts/generate-preview.py` regenerates `preview.png` from the isolated demo render and cleans up its temporary Herdr instance.
