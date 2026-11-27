// Kent spaces: program-icon rows in named, foldable groups inside each machine.
// Worktrees stay under their checkout and the git tail follows Herdr's spaces list.
// Click to switch, right-click to assign a group, drag onto a group or another row.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { spaces, machines, panes, agents, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout, nextCommand, checking, settings } from "herdr";
import { iconChip } from "./icon-chip.js";
import { checkKentUpdate } from "./update-check.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 26 : 28);
const RAIL_CELL = 32;
// A space's name never shrinks below this, so a short one ("api") stays readable
// instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
// A row can only show part of a long name, and the numbered rail shows none
// of it: the tooltip says the whole name, and the machine when it isn't this one.
const nameTip = (w) => (w.machine ? `${w.machine} · ${w.name}` : w.name);
// Only a name this long is cut in the middle: a long one often tells spaces apart by its
// end ("…-HYJ397"), which an ellipsis at the end takes away with the rest.
const LONG_NAME = 16;
// How close to the list's top or bottom edge a dragged row is held for the list to scroll
// that way, so a group out of sight can be dropped on. In the list's own pixels.
const EDGE = 28;
// A row dragged past a group header on its way somewhere else should not flash that
// header's drop ring, so the ring waits this long before it shows. In milliseconds.
const RING_DELAY = 150;
// A git tail narrower than this (about eight characters) is not drawn: a stub of a repo or
// branch name next to a full name reads as noise.
const TAIL_MIN = 56;
// Sidebar text is 13px: a Latin glyph is about 7.8 wide, while CJK and emoji take a
// full em (about 13). A name and its git tail share one row, so treating a CJK name
// as Latin leaves room the tail does not really have and crowds the name.
const charPx = (cp) => {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff)
    || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff)
    || (cp >= 0xfe20 && cp <= 0xfe2f)) return 0;
  return ((cp >= 0x1100 && cp <= 0x115f)
    || cp === 0x2329 || cp === 0x232a
    || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe19)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f000 && cp <= 0x1faff)
    || (cp >= 0x20000 && cp <= 0x3fffd)) ? 13 : 7.8;
};
const textPx = (text) => {
  let px = 0;
  for (const ch of text) px += charPx(ch.codePointAt(0));
  return px;
};
// What a list child takes up from the top of the list: `h`, as each says when it is made
// (the same pixels as scroll.offset()), a row's height until it says.
const ofItem = (m) => m?.h ?? 28;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// A repo's name from its git folder: the folder holding .git, a bare repo's own
// name, or the folder holding a hidden bare repo (<project>/.bare).
const repoName = (common) => {
  if (common.endsWith("/.git")) return base(common.slice(0, -5));
  const own = base(common);
  return own === ".bare" ? base(common.slice(0, -own.length - 1)) : own.replace(/\.git$/, "");
};
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files (256 when started from the Dock on macOS) or
// past a machine core's 16 running execs, and those spaces wait for FALLBACK.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// Keep the whole leading emoji when comparing a space's name with its repo or branch.
// Newer pictographs such as 🖥 may be drawn as emoji without VS16. A trailing
// selector, modifier or joiner can signal that we matched only part of a glyph.
const EMOJI = /^(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|(?:\p{Emoji_Presentation}|(?=[\u{1F000}-\u{1FFFF}])\p{Extended_Pictographic}|\p{Extended_Pictographic}(?=\uFE0F)|\p{Emoji_Modifier_Base}(?=\p{Emoji_Modifier}))\uFE0F?[\p{Emoji_Modifier}\u{E0020}-\u{E007F}]*(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)(?![\p{Grapheme_Extend}\p{Emoji_Modifier}\u200D])/u;

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

const STORE = "kent.groups.v1";
const GROUP_DOC = "kent.groups.v1";
const MIGRATED_KEY = "kent.groups.sync.migrated";
const PENDING_KEY = "kent.groups.pending.v1";
const VERSIONS_KEY = "kent.groups.sync.versions";
const PROJECTS_KEY = "kent.projects.v1";
const PARKED_FOLDED_KEY = "kent.parked.folded";
const PROJECT_CAP = 50;
const DEFAULT_GROUP = "__default__";
const groupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const pendingGroupSpaces = [];
let wakeGroupSpaces = null;
const spaceCreations = new Map(); // machine/null -> in-flight creations on it

// A project is the folder a closed space worked in. Paths from two machines can
// look alike, so the machine is part of the key. Trailing separators are noise.
const normPath = (path) => (typeof path === "string" ? path.replace(/\\/g, "/").replace(/\/+$/, "") : "");
const projectKeyOf = (machine, folder) => `${machine ?? ""}\u0000${normPath(folder)}`;
const projectTail = (folder) => base(String(folder ?? "").replace(/\\/g, "/")) || folder;

function readProjects() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeProjects(data) {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(data)); } catch {}
}

function cleanProject(p) {
  if (!p || typeof p.folder !== "string" || !normPath(p.folder)) return null;
  return {
    folder: p.folder,
    name: typeof p.name === "string" ? p.name : "",
    named: Boolean(p.named),
    group: typeof p.group === "string" && p.group ? p.group : null,
    at: typeof p.at === "number" ? p.at : 0,
  };
}

function projectEntries(machine) {
  const all = readProjects();
  const list = Array.isArray(all[machine ?? ""]) ? all[machine ?? ""] : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const p = cleanProject(raw);
    if (!p) continue;
    const key = projectKeyOf(machine, p.folder);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function saveProjectEntries(machine, list) {
  const all = readProjects();
  const key = machine ?? "";
  const clean = list.map(cleanProject).filter(Boolean).slice(0, PROJECT_CAP);
  if (clean.length) all[key] = clean;
  else delete all[key];
  writeProjects(all);
}

// Closing a space leaves a drawer rather than a hole. The newest closes first,
// and a folder already in the drawer is refreshed rather than duplicated.
function rememberProject({ machine = null, folder, name = "", named = false, group = null }) {
  if (!normPath(folder)) return false;
  const list = projectEntries(machine);
  const key = projectKeyOf(machine, folder);
  const item = cleanProject({
    folder,
    name: name || projectTail(folder),
    named,
    group,
    at: Date.now(),
  });
  const next = [item, ...list.filter((p) => projectKeyOf(machine, p.folder) !== key)];
  saveProjectEntries(machine, next);
  return true;
}

function forgetProject(machine, folder) {
  const key = projectKeyOf(machine, folder);
  const list = projectEntries(machine);
  const next = list.filter((p) => projectKeyOf(machine, p.folder) !== key);
  if (next.length === list.length) return false;
  saveProjectEntries(machine, next);
  return true;
}


function beginSpaceCreation(machine) {
  machine = machine ?? null;
  spaceCreations.set(machine, (spaceCreations.get(machine) ?? 0) + 1);
}

function endSpaceCreation(machine) {
  machine = machine ?? null;
  const left = (spaceCreations.get(machine) ?? 0) - 1;
  if (left > 0) spaceCreations.set(machine, left);
  else spaceCreations.delete(machine);
}
// The mod's load time stands in for the app's start: a machine that answers
// with no spaces at all within this grace window may simply still be loading,
// so its group membership is not pruned yet.
const startedAt = Date.now();
const STARTUP_GRACE = 10000;
const PRUNE_EVERY = 60000;
const SYNC_EVERY = 3000;
// A sync worker belongs to the mod copy whose cx started it and dies with
// that copy. The heartbeat lets a surviving copy adopt the shared worker.
const SYNC_STALE = 9000;
const SYNC_RETRY = 10000;
const SYNC_UNSUPPORTED_RETRY = 60000;
const SYNC_CONFLICTS = 6;
// A version regression is usually just two hc connect processes answering out
// of order. If it persists across several polls, the machine core was rebuilt
// or lost its documents; versions from that new incarnation are not comparable.
const SYNC_RESET_GRACE = 12000;

// Space ids shown by the app are client-qualified on another machine
// ("4090/sp…"). The machine's own document stores the machine-local id, so two
// clients that call the same machine by different names still mean the same space.
function bareSpaceId(id, machine) {
  const prefix = `${machine}/`;
  return machine && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function clientSpaceId(id, machine) {
  const prefix = `${machine}/`;
  return machine && !id.startsWith(prefix) ? `${prefix}${id}` : id;
}

function copyMachineData(data) {
  return JSON.parse(JSON.stringify(data));
}

function emptyMachineData() {
  return { groups: [], in: {}, defaultFolded: false, at: 0 };
}

// One machine's canonical document. A bare space id is in at most one group's
// ordered list; absence from every list means the space is ungrouped.
function normalizeMachineData(raw, machine = null) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawGroups = Array.isArray(source.groups) ? source.groups : [];
  const groups = [];
  const groupIds = new Set();
  for (const g of rawGroups) {
    if (!g || typeof g.id !== "string" || !g.id || groupIds.has(g.id)) continue;
    groupIds.add(g.id);
    groups.push({
      id: g.id,
      name: typeof g.name === "string" && g.name.trim() ? g.name : "Group",
      folded: Boolean(g.folded),
    });
  }
  const rawIn = source.in && typeof source.in === "object" && !Array.isArray(source.in) ? source.in : {};
  const seen = new Set();
  const membership = {};
  for (const g of groups) {
    membership[g.id] = [];
    const list = Array.isArray(rawIn[g.id]) ? rawIn[g.id] : [];
    for (const rawId of list) {
      if (typeof rawId !== "string" || !rawId) continue;
      const id = bareSpaceId(rawId, machine);
      // Canonical machine-local space ids never contain a slash. Anything left
      // with one belongs to another machine alias (or is corrupt), so carrying
      // it into this machine's document would make membership unmatchable.
      if (!id || id.includes("/") || seen.has(id)) continue;
      seen.add(id);
      membership[g.id].push(id);
    }
  }
  let defaultFolded = false;
  if (typeof source.defaultFolded === "boolean") defaultFolded = source.defaultFolded;
  else if (source.defaultFolded && typeof source.defaultFolded === "object" && !Array.isArray(source.defaultFolded)) {
    defaultFolded = Boolean(source.defaultFolded[machine ?? ""]);
  }
  return { groups, in: membership, defaultFolded, at: typeof source.at === "number" ? source.at : 0 };
}

// The old shared-store shape, still used as a migration source and as a local
// backup when a core is too old for documents or cannot be reached yet.
function readLegacyShared() {
  const raw = shared(STORE) ?? {};
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  const groups = [];
  const groupIds = new Set();
  for (const g of rawGroups) {
    if (!g || typeof g.id !== "string" || !g.id || groupIds.has(g.id)) continue;
    groupIds.add(g.id);
    groups.push({
      id: g.id,
      name: typeof g.name === "string" && g.name.trim() ? g.name : "Group",
      machine: typeof g.machine === "string" ? g.machine : null,
      folded: Boolean(g.folded),
    });
  }
  const rawIn = raw.in && typeof raw.in === "object" && !Array.isArray(raw.in) ? raw.in : {};
  const seen = new Set();
  const membership = {};
  for (const g of groups) {
    membership[g.id] = [];
    const list = Array.isArray(rawIn[g.id]) ? rawIn[g.id] : [];
    for (const id of list) {
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      membership[g.id].push(id);
    }
  }
  const rawDefaultFolded = raw.defaultFolded && typeof raw.defaultFolded === "object" && !Array.isArray(raw.defaultFolded) ? raw.defaultFolded : {};
  const defaultFolded = {};
  for (const [machine, folded] of Object.entries(rawDefaultFolded)) {
    if (typeof folded === "boolean") defaultFolded[machine] = folded;
  }
  return { groups, in: membership, defaultFolded };
}

function legacyMachineData(machine) {
  machine = machine ?? null;
  const legacy = readLegacyShared();
  const data = emptyMachineData();
  for (const g of legacy.groups) {
    if ((g.machine ?? null) !== machine) continue;
    data.groups.push({ id: g.id, name: g.name, folded: Boolean(g.folded) });
    // Older clients always stored remote rows in this client's qualified form.
    // If the machine was renamed afterwards, that qualifier is an old alias
    // rather than the current one; because canonical space ids cannot contain
    // a slash, any leading qualifier in legacy remote data is safe to discard.
    data.in[g.id] = (legacy.in[g.id] ?? []).map((id) => machine && id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);
  }
  data.defaultFolded = Boolean(legacy.defaultFolded[machine ?? ""]);
  return normalizeMachineData(data, machine);
}

function hasLegacyData(data) {
  return Boolean(data.groups.length || data.defaultFolded || Object.values(data.in).some((list) => list.length));
}

function migrationMarks() {
  const marks = shared(MIGRATED_KEY);
  return marks && typeof marks === "object" && !Array.isArray(marks) ? { ...marks } : {};
}

function migrationDone(machine) {
  return Boolean(migrationMarks()[machine ?? ""]);
}

function markMigrationDone(machine) {
  const marks = migrationMarks();
  marks[machine ?? ""] = Date.now();
  setShared(MIGRATED_KEY, marks);
}

function resetMigrationDone(machine) {
  const marks = migrationMarks();
  delete marks[machine ?? ""];
  setShared(MIGRATED_KEY, marks);
}


function docVersions() {
  const versions = shared(VERSIONS_KEY);
  return versions && typeof versions === "object" && !Array.isArray(versions) ? { ...versions } : {};
}

function rememberedDocVersion(machine) {
  const version = docVersions()[machine ?? ""];
  return typeof version === "number" && version > 0 ? version : 0;
}

function rememberDocVersion(machine, version) {
  if (!(version > 0) || version <= rememberedDocVersion(machine)) return;
  const versions = docVersions();
  versions[machine ?? ""] = version;
  setShared(VERSIONS_KEY, versions);
}

function resetRememberedDocVersion(machine) {
  const versions = docVersions();
  if (!Object.prototype.hasOwnProperty.call(versions, machine ?? "")) return;
  delete versions[machine ?? ""];
  setShared(VERSIONS_KEY, versions);
}

function memberOfAnyGroup(data, id) {
  for (const list of Object.values(data.in)) if (list.includes(id)) return true;
  return false;
}

// Merge one client's old local groups into the machine document exactly once.
// Same-named groups are treated as the same group: independently generated old
// ids cannot be matched any better, and duplicating them would be worse. Remote
// membership wins when a space is already claimed.
function mergeLegacyData(data, legacy) {
  let changed = false;
  for (const legacyGroup of legacy.groups) {
    let target = data.groups.find((g) => g.id === legacyGroup.id)
      ?? data.groups.find((g) => g.name === legacyGroup.name);
    if (!target) {
      target = { id: legacyGroup.id, name: legacyGroup.name, folded: Boolean(legacyGroup.folded) };
      data.groups.push(target);
      data.in[target.id] = [];
      changed = true;
    }
    const list = data.in[target.id] ??= [];
    for (const id of legacy.in[legacyGroup.id] ?? []) {
      if (memberOfAnyGroup(data, id)) continue;
      list.push(id);
      changed = true;
    }
  }
  // A written document's false is an intentional state, not merely a missing
  // value. Only the first migration onto an unwritten document carries the old
  // default group's fold flag over.
  if (legacy.defaultFolded && !data.defaultFolded && !data.at) {
    data.defaultFolded = true;
    changed = true;
  }
  return changed ? data : null;
}

const groupSync = {
  started: false,
  generation: 0,
  owners: new Set(), // main copies using the shared worker; prompts/menus do not count
  stores: new Map(), // machine name/null -> canonical cache, queue and core version
  wake: null,
  notify: null,
  polling: false,
  rpcWarned: false,
};

function wakeGroupSync() {
  groupSync.wake?.();
}

function queueMigration(st) {
  if (checking() || migrationDone(st.machine)) return;
  if (!hasLegacyData(st.legacy)) {
    markMigrationDone(st.machine);
    return;
  }
  if (st.migrateQueued) return;
  st.migrateQueued = true;
  const legacy = copyMachineData(st.legacy);
  st.queue.push({
    id: `migration-${st.machine ?? "local"}`,
    intent: { type: "migration", legacy },
    label: "migrate legacy groups",
    migration: true,
    apply: (data) => applyGroupIntent(st.machine, { type: "migration", legacy }, data),
  });
  wakeGroupSync();
}

function machineStore(machine) {
  machine = machine ?? null;
  let st = groupSync.stores.get(machine);
  if (st) return st;
  const legacy = legacyMachineData(machine);
  st = {
    machine,
    legacy,
    data: copyMachineData(legacy),
    version: 0,
    loaded: false,
    queue: [],
    active: null,
    retryAt: 0,
    refreshAfter: 0,
    migrateQueued: false,
    regressionSince: 0,
    error: null,
    errorKind: null,
    errorUnavailable: false,
  };
  groupSync.stores.set(machine, st);
  queueMigration(st);
  restorePendingGroupOps(st);
  return st;
}

function syncMachineNames() {
  const out = [];
  const seen = new Set();
  const add = (machine) => {
    machine = machine ?? null;
    if (seen.has(machine)) return;
    seen.add(machine);
    out.push(machine);
  };
  add(null);
  for (const g of readLegacyShared().groups) add(g.machine ?? null);
  for (const m of machines()) add(m.name ?? null);
  for (const s of spaces()) add(s.machine ?? null);
  for (const machine of groupSync.stores.keys()) add(machine);
  return out;
}

// The renderer still reads one synchronous aggregate in the old shape. It is a
// view over the per-machine caches; canonical ids become this client's ids here.
function readStore() {
  const out = { groups: [], in: {}, defaultFolded: {} };
  const groupIds = new Set();
  for (const machine of syncMachineNames()) {
    const st = machineStore(machine);
    for (const g of st.data.groups) {
      if (groupIds.has(g.id)) continue;
      groupIds.add(g.id);
      out.groups.push({ id: g.id, name: g.name, machine, folded: Boolean(g.folded) });
      out.in[g.id] = (st.data.in[g.id] ?? []).map((id) => clientSpaceId(id, machine));
    }
    out.defaultFolded[machine ?? ""] = Boolean(st.data.defaultFolded);
  }
  return out;
}

function legacySignature(raw) {
  return JSON.stringify({
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    in: raw.in && typeof raw.in === "object" && !Array.isArray(raw.in) ? raw.in : {},
    defaultFolded: raw.defaultFolded && typeof raw.defaultFolded === "object" && !Array.isArray(raw.defaultFolded) ? raw.defaultFolded : {},
  });
}

// Keep the old client-local snapshot as a backup and compatibility fallback.
// The core document is authoritative once written; this is what lets an old or
// temporarily unreachable core behave exactly like the previous Kent release.
let writingLegacySnapshot = false;

function writeLegacySnapshot() {
  if (checking() || writingLegacySnapshot) return;
  writingLegacySnapshot = true;
  try {
    const data = readStore();
    const next = { version: 1, groups: data.groups, in: data.in, defaultFolded: data.defaultFolded, at: Date.now() };
    if (legacySignature(shared(STORE) ?? {}) === legacySignature(next)) return;
    setShared(STORE, next);
  } finally {
    writingLegacySnapshot = false;
  }
}

// User operations are serializable intents rather than closures. The queue can
// therefore survive an app restart and, just as importantly, be replayed against
// the newest machine document instead of a stale snapshot.
function applyGroupIntent(machine, intent, data) {
  machine = machine ?? null;
  switch (intent.type) {
    case "migration":
      return mergeLegacyData(data, normalizeMachineData(intent.legacy, machine));
    case "create": {
      // New operations have stable generated ids, unlike legacy migration data.
      // Do not coalesce a same-named group here: a later assign intent still
      // refers to this id, and merging the create away would silently drop it.
      const before = JSON.stringify({ groups: data.groups, in: data.in });
      let group = data.groups.find((g) => g.id === intent.id);
      if (!group) {
        group = { id: intent.id, name: intent.name, folded: false };
        data.groups.push(group);
        data.in[intent.id] = [];
      }
      if (intent.space) {
        removeFromGroups(data, intent.space);
        const list = data.in[group.id] ??= [];
        if (!list.includes(intent.space)) list.push(intent.space);
      }
      pruneMachineData(data, machine);
      return JSON.stringify({ groups: data.groups, in: data.in }) !== before ? data : null;
    }
    case "rename": {
      const group = data.groups.find((g) => g.id === intent.id);
      if (!group || group.name === intent.name) return null;
      group.name = intent.name;
      return data;
    }
    case "delete": {
      const at = data.groups.findIndex((g) => g.id === intent.id);
      if (at === -1) return null;
      data.groups.splice(at, 1);
      delete data.in[intent.id];
      pruneMachineData(data, machine);
      return data;
    }
    case "fold": {
      if (intent.defaultGroup) {
        if (data.defaultFolded === Boolean(intent.folded)) return null;
        data.defaultFolded = Boolean(intent.folded);
        return data;
      }
      const group = data.groups.find((g) => g.id === intent.id);
      if (!group || group.folded === Boolean(intent.folded)) return null;
      group.folded = Boolean(intent.folded);
      return data;
    }
    case "move": {
      const at = data.groups.findIndex((g) => g.id === intent.id);
      if (at === -1 || !data.groups.some((g) => g.id === intent.anchor)) return null;
      const before = data.groups.map((g) => g.id).join("\u0000");
      const [group] = data.groups.splice(at, 1);
      const anchorAt = data.groups.findIndex((g) => g.id === intent.anchor);
      data.groups.splice(anchorAt + (intent.afterAnchor ? 1 : 0), 0, group);
      return data.groups.map((g) => g.id).join("\u0000") !== before ? data : null;
    }
    case "assign": {
      if (intent.targetGroup && !data.groups.some((g) => g.id === intent.targetGroup)) return null;
      const before = JSON.stringify(data.in);
      removeFromGroups(data, intent.space);
      if (intent.targetGroup) {
        const list = data.in[intent.targetGroup] ??= [];
        const at = intent.targetId ? list.indexOf(intent.targetId) : -1;
        if (at === -1) list.push(intent.space);
        else list.splice(at + (intent.after ? 1 : 0), 0, intent.space);
      }
      pruneMachineData(data, machine);
      return JSON.stringify(data.in) !== before ? data : null;
    }
    case "prune": {
      const before = JSON.stringify(data.in);
      pruneMachineData(data, machine);
      return JSON.stringify(data.in) !== before ? data : null;
    }
    default:
      throw new Error(`unknown group operation ${intent.type}`);
  }
}

function pendingGroupOps() {
  const pending = shared(PENDING_KEY);
  return pending && typeof pending === "object" && !Array.isArray(pending) ? { ...pending } : {};
}

function writePendingGroupOps(pending) {
  setShared(PENDING_KEY, pending);
}

function persistGroupOp(machine, op) {
  const key = machine ?? "";
  const pending = pendingGroupOps();
  const list = Array.isArray(pending[key]) ? [...pending[key]] : [];
  if (!list.some((entry) => entry?.id === op.id)) list.push({ id: op.id, intent: op.intent, at: Date.now() });
  pending[key] = list;
  writePendingGroupOps(pending);
}

function clearPendingGroupOp(machine, id) {
  const key = machine ?? "";
  const pending = pendingGroupOps();
  const list = Array.isArray(pending[key]) ? [...pending[key]] : [];
  const kept = list.filter((entry) => entry?.id !== id);
  if (kept.length) pending[key] = kept;
  else delete pending[key];
  writePendingGroupOps(pending);
}


function legacyGroupIdMap(legacy, data) {
  const map = {};
  for (const legacyGroup of legacy?.groups ?? []) {
    if (!legacyGroup?.id || data.groups.some((g) => g.id === legacyGroup.id)) continue;
    const target = data.groups.find((g) => g.name === legacyGroup.name);
    if (target) map[legacyGroup.id] = target.id;
  }
  return map;
}

function remapGroupIntent(intent, map) {
  const next = { ...intent };
  if ((next.type === "create" || next.type === "rename" || next.type === "delete" || next.type === "fold" || next.type === "move") && map[next.id]) next.id = map[next.id];
  if (next.type === "move" && map[next.anchor]) next.anchor = map[next.anchor];
  if (next.type === "assign" && map[next.targetGroup]) next.targetGroup = map[next.targetGroup];
  return next;
}

function rewriteQueuedGroupOps(st, map) {
  if (!Object.keys(map).length) return;
  for (const op of st.queue) {
    if (op.intent?.type !== "migration") op.intent = remapGroupIntent(op.intent, map);
  }
  const key = st.machine ?? "";
  const pending = pendingGroupOps();
  const list = Array.isArray(pending[key]) ? pending[key].map((entry) => entry ? { ...entry } : entry) : [];
  for (const entry of list) if (entry?.intent) entry.intent = remapGroupIntent(entry.intent, map);
  if (list.length) pending[key] = list;
  writePendingGroupOps(pending);
}

function finishMigration(st, op, data) {
  rewriteQueuedGroupOps(st, legacyGroupIdMap(op.intent?.legacy, data));
  markMigrationDone(st.machine);
  st.migrateQueued = false;
}

function applyGroupOp(op, data) {
  try { return op.apply(data); }
  catch (e) {
    console.log(`kent: group ${op.label ?? "change"} failed to apply: ${e.message ?? e}`);
    return null;
  }
}

function enqueueGroupOp(machine, intent, {
  label = "change",
  persist = true,
  id = null,
} = {}) {
  const st = machineStore(machine);
  const op = {
    id: id ?? `op${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    intent,
    label,
    migration: false,
    apply: null,
  };
  op.apply = (data) => applyGroupIntent(machine, op.intent, data);
  const draft = copyMachineData(st.data);
  const next = applyGroupOp(op, draft);
  // Even a local no-op is still queued. The cache can be behind another
  // client, and the user's intent must be replayed against the canonical
  // document rather than discarded because a stale snapshot already matches.
  // Persist before touching the compatibility snapshot: even a crash between
  // those two writes must leave behind enough information to replay the intent.
  if (persist) persistGroupOp(machine, op);
  if (next) {
    st.data = normalizeMachineData(next, st.machine);
    // Restored operations are already persisted and are often reconstructed
    // while a render is reading the store. Avoid a nested shared-state write
    // there; normal user operations still update the compatibility snapshot.
    if (persist) writeLegacySnapshot();
  }
  st.queue.push(op);
  wakeGroupSync();
  groupSync.notify?.();
  return true;
}

function restorePendingGroupOps(st) {
  const list = pendingGroupOps()[st.machine ?? ""];
  if (!Array.isArray(list)) return;
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id) || !entry.intent || typeof entry.intent !== "object") continue;
    seen.add(entry.id);
    // The compatibility snapshot often already contains this operation's effect.
    // Queue it anyway: that proves nothing about the canonical machine document.
    enqueueGroupOp(st.machine, entry.intent, {
      label: entry.intent.type ?? "change",
      persist: false,
      id: entry.id,
    });
  }
}

let rpcSerial = 0;

async function pipeToHcConnect(input) {
  if (window()?.platform === "windows") {
    // The payload is ASCII-encoded below, and every JSON-RPC request line
    // starts with `{"jsonrpc"`, so a PowerShell here-string carries it without
    // depending on the quoting of a native command-line argument.
    const command = `$payload = @'\n${input}'@\n$payload | hc connect`;
    return exec("powershell", ["-NoProfile", "-Command", command], { timeout: 15000 });
  }
  return exec("sh", ["-c", 'printf %s "$0" | hc connect', input], { timeout: 15000 });
}

// hc's document API is newline JSON-RPC over `hc connect`. exec has no stdin,
// so the payload is passed as one argument and a tiny shell pipeline feeds it in.
async function coreRpc(calls) {
  const requests = calls.map((call) => ({ jsonrpc: "2.0", id: ++rpcSerial, ...call }));
  // Keep the wire bytes ASCII: group names may be Unicode, while PowerShell's
  // native-command pipeline encoding differs between Windows PowerShell editions.
  const asciiJson = (value) => JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  const input = requests.map((request) => asciiJson(request)).join("\n") + "\n";
  const r = await pipeToHcConnect(input);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || `hc connect exited ${r.code}`);
  const byId = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const response = JSON.parse(line.replace(/^\uFEFF/, ""));
    if (response.id !== undefined) byId.set(response.id, response);
  }
  return requests.map((request) => byId.get(request.id));
}

function unwrapRpc(response) {
  if (!response) throw new Error("herdr-core did not answer");
  if (response.error) {
    const e = new Error(response.error.message || response.error.data?.kind || "herdr-core request failed");
    e.kind = response.error.data?.kind;
    e.code = response.error.code;
    if (e.kind === "needs_update" || e.code === -32601) e.unsupported = true;
    throw e;
  }
  return response.result;
}

async function docGet(machine) {
  const [response] = await coreRpc([{ method: "doc.get", params: { name: GROUP_DOC, on: machine ?? null } }]);
  return unwrapRpc(response);
}

async function docSet(machine, value, version) {
  const [response] = await coreRpc([{ method: "doc.set", params: { name: GROUP_DOC, on: machine ?? null, value, version } }]);
  return unwrapRpc(response);
}

function isConflict(e) {
  return e.kind === "conflict" || /conflict|version/i.test(e.message ?? "");
}

function rebuildOptimistic(st, authoritative) {
  let data = copyMachineData(authoritative);
  const pending = [...(st.active ? [st.active] : []), ...st.queue];
  for (const op of pending) {
    const next = applyGroupOp(op, copyMachineData(data));
    if (next) data = normalizeMachineData(next, st.machine);
  }
  return data;
}

function queueCoreResetRepair(st) {
  // Reset the migration marker first: if the app dies halfway through this
  // repair, the compatibility snapshot must be eligible to migrate again.
  resetMigrationDone(st.machine);
  resetRememberedDocVersion(st.machine);
  const repair = copyMachineData(st.data);
  if (!hasLegacyData(repair)) {
    markMigrationDone(st.machine);
    return false;
  }
  st.queue.unshift({
    id: `repair-${st.machine ?? "local"}-${Date.now().toString(36)}`,
    intent: { type: "migration", legacy: repair },
    label: "restore groups after core reset",
    migration: true,
    apply: (data) => applyGroupIntent(st.machine, { type: "migration", legacy: repair }, data),
  });
  wakeGroupSync();
  return true;
}

function adoptRemote(st, authoritative, version) {
  // Two `hc connect` processes can answer out of order. Never rewind to an
  // older document version merely because a slow poll finished after a write.
  // The remembered version extends that protection across an app restart; it
  // is reset when a sustained regression proves the core is a new incarnation.
  const remembered = rememberedDocVersion(st.machine);
  const knownVersion = Math.max(st.loaded ? st.version : 0, remembered);
  let reset = false;
  if (knownVersion && version < knownVersion) {
    if (!st.regressionSince) {
      st.regressionSince = Date.now();
      return;
    }
    if (Date.now() - st.regressionSince < SYNC_RESET_GRACE) return;
    // A sustained regression means this is a different core incarnation (for
    // example a rebuilt machine), not a stale response. Repair it from the
    // current optimistic cache. Resetting the migration marker also makes the
    // compatibility snapshot migrate again if the app restarts before repair.
    reset = true;
    st.regressionSince = 0;
    queueCoreResetRepair(st);
  } else st.regressionSince = 0;
  const before = JSON.stringify({ groups: st.data.groups, in: st.data.in, defaultFolded: st.data.defaultFolded });
  st.version = version;
  st.loaded = true;
  st.error = null;
  st.errorKind = null;
  st.errorUnavailable = false;
  st.data = rebuildOptimistic(st, authoritative);
  if (reset || version > remembered) rememberDocVersion(st.machine, version);
  const after = JSON.stringify({ groups: st.data.groups, in: st.data.in, defaultFolded: st.data.defaultFolded });
  // The shared snapshot is only a fallback/migration source, but keeping it
  // current is what lets Kent behave like the old local version while a core
  // is unreachable or too old for documents.
  if (after !== before) writeLegacySnapshot();
}

async function processGroupOp(st, op) {
  let conflict = null;
  for (let attempt = 0; attempt < SYNC_CONFLICTS; attempt += 1) {
    const current = await docGet(st.machine);
    const remote = normalizeMachineData(current.value, st.machine);
    // Unlike a poll response, this read was issued now. A version below every
    // incarnation this client remembers is definitive proof of a core reset,
    // so repair before writing this operation onto an empty new document.
    const knownVersion = Math.max(st.loaded ? st.version : 0, rememberedDocVersion(st.machine));
    if (knownVersion && current.version < knownVersion) {
      st.queue.unshift(op);
      queueCoreResetRepair(st);
      st.version = current.version;
      st.loaded = true;
      st.error = null;
      st.regressionSince = 0;
      st.data = rebuildOptimistic(st, remote);
      rememberDocVersion(st.machine, current.version);
      return;
    }
    const draft = copyMachineData(remote);
    const next = applyGroupOp(op, draft);
    if (!next) {
      adoptRemote(st, remote, current.version);
      clearPendingGroupOp(st.machine, op.id);
      if (op.migration) finishMigration(st, op, remote);
      return;
    }
    const clean = normalizeMachineData(next, st.machine);
    clean.at = Date.now();
    try {
      const written = await docSet(st.machine, clean, current.version);
      adoptRemote(st, clean, written.version);
      clearPendingGroupOp(st.machine, op.id);
      if (op.migration) finishMigration(st, op, clean);
      return;
    } catch (e) {
      if (!isConflict(e)) throw e;
      conflict = e;
    }
  }
  throw conflict ?? new Error("group sync kept conflicting");
}

function nextQueuedGroupOp() {
  const now = Date.now();
  for (const st of groupSync.stores.values()) {
    if ((st.retryAt ?? 0) > now) continue;
    if (st.queue.length) return { st, op: st.queue.shift() };
  }
  return null;
}

function hasQueuedGroupOps() {
  for (const st of groupSync.stores.values()) if (st.queue.length) return true;
  return false;
}

async function groupMutationWorker(cx, generation) {
  for (;;) {
    if (groupSync.generation !== generation) return;
    const next = nextQueuedGroupOp();
    if (!next) {
      if (hasQueuedGroupOps()) await cx.sleep(500);
      else {
        await new Promise((resolve) => { groupSync.wake = resolve; });
        groupSync.wake = null;
      }
      continue;
    }
    next.st.active = next.op;
    try {
      await processGroupOp(next.st, next.op);
    } catch (e) {
      const message = String(e.message ?? e);
      if (next.st.error !== message) console.log(`kent: group sync failed for ${next.st.machine ?? "this computer"}: ${message}`);
      next.st.error = message;
      // Even an old core is treated as a temporary sync failure: the operation
      // stays queued and the local shared snapshot remains the compatibility
      // copy. This both avoids losing a migration and lets sync recover after
      // that machine's core is updated, without an app restart.
      next.st.queue.unshift(next.op);
      const unavailable = machines().find((m) => (m.name ?? null) === next.st.machine)?.layout === "unavailable";
      next.st.errorKind = e.kind ?? null;
      next.st.errorUnavailable = unavailable;
      const slow = e.unsupported || e.kind === "machine_unknown" || unavailable;
      next.st.retryAt = Date.now() + (slow ? SYNC_UNSUPPORTED_RETRY : SYNC_RETRY);
      if (e.unsupported) next.st.refreshAfter = next.st.retryAt;
    } finally {
      if (next.st.active === next.op) next.st.active = null;
    }
    cx.notify();
  }
}

function pollError(st, e) {
  st.error = String(e.message ?? e);
  st.errorKind = e.kind ?? null;
  const slow = e.unsupported || e.kind === "machine_unknown";
  st.refreshAfter = Date.now() + (slow ? SYNC_UNSUPPORTED_RETRY : SYNC_RETRY);
}

function refreshGroupDocs(cx) {
  if (checking() || groupSync.polling || window()?.visible === false) return;
  const now = Date.now();
  const layoutByMachine = new Map(machines().map((m) => [m.name ?? null, m.layout]));
  for (const st of groupSync.stores.values()) {
    // Recovery from being offline/unknown should be visible within one poll
    // interval, not after the long failure backoff. Persistent local RPC or
    // unsupported-core failures keep their backoff because layout readiness
    // does not make them any more likely to succeed.
    if (layoutByMachine.get(st.machine) === "ready" && (st.errorUnavailable || st.errorKind === "machine_unknown")) {
      st.retryAt = 0;
      st.refreshAfter = 0;
      st.errorUnavailable = false;
      st.errorKind = null;
    }
  }
  const targets = syncMachineNames()
    .map((machine) => machineStore(machine))
    .filter((st) => {
      if ((st.refreshAfter ?? 0) > now) return false;
      // A machine whose layout core is already known to be offline can make one
      // batched RPC wait for its network timeout and delay every other machine.
      // Leave its queued intents to the mutation retry path and poll it later.
      if (layoutByMachine.get(st.machine) === "unavailable") {
        st.refreshAfter = now + SYNC_RETRY;
        return false;
      }
      return true;
    });
  if (!targets.length) return;
  groupSync.polling = true;
  cx.spawn(async (cx) => {
    try {
      try {
        const responses = await coreRpc(targets.map((st) => ({
          method: "doc.get",
          params: { name: GROUP_DOC, on: st.machine ?? null },
        })));
        targets.forEach((st, i) => {
          try {
            const result = unwrapRpc(responses[i]);
            adoptRemote(st, normalizeMachineData(result.value, st.machine), result.version);
            st.refreshAfter = 0;
          } catch (e) { pollError(st, e); }
        });
      } catch (e) {
        if (!groupSync.rpcWarned) {
          console.log(`kent: group sync poll failed: ${e.message ?? e}`);
          groupSync.rpcWarned = true;
        }
        for (const st of targets) st.refreshAfter = Date.now() + SYNC_RETRY;
      }
    } finally {
      groupSync.polling = false;
      cx.notify();
    }
  });
}

function startGroupSync(cx) {
  if (checking()) return;
  if (groupSync.started) {
    if (Date.now() - (groupSync.heartbeat ?? 0) < SYNC_STALE) return;
    stopGroupSync();
  }
  groupSync.started = true;
  groupSync.heartbeat = Date.now();
  const generation = ++groupSync.generation;
  groupSync.notify = () => {
    if (groupSync.generation === generation) cx.notify();
  };
  cx.spawn(async (cx) => groupMutationWorker(cx, generation));
  cx.timer.every(SYNC_EVERY, (cx) => {
    if (groupSync.generation !== generation) return;
    groupSync.heartbeat = Date.now();
    refreshGroupDocs(cx);
  });
  refreshGroupDocs(cx);
}

function stopGroupSync() {
  if (!groupSync.started) return;
  groupSync.started = false;
  groupSync.generation += 1;
  groupSync.notify = null;
  wakeGroupSync();
}

// Whether a machine's spaces are known: `machines()` describes the layout
// documents of the *other* machines (this computer has none — its spaces are
// the app's own), so its entry decides for them, while this computer counts as
// ready unless an entry says otherwise.
function machineReady(ms, machine) {
  const entry = ms.find((m) => (m.name ?? null) === (machine ?? null));
  return entry ? entry.layout === "ready" : (machine ?? null) === null;
}

// Closed spaces leave their ids behind in group membership. Prune them only
// when this machine's layout is definitely answering; an away or still-loading
// machine keeps every id because its spaces simply aren't here to ask.
function pruneMachineData(data, machine, sp = spaces(), ms = machines(), busyMachines = new Set(spaceCreations.keys())) {
  if (checking()) return false;
  machine = machine ?? null;
  if (busyMachines.has(machine)) return false;
  if (!machineReady(ms, machine)) return false;
  const live = new Set(sp.filter((s) => (s.machine ?? null) === machine).map((s) => bareSpaceId(s.id, machine)));
  if (!live.size && Date.now() - startedAt < STARTUP_GRACE) return false;
  let removed = false;
  for (const g of data.groups) {
    const list = data.in[g.id];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((id) => live.has(id));
    if (kept.length !== list.length) {
      data.in[g.id] = kept;
      removed = true;
    }
  }
  return removed;
}

function queueNewSpaceInGroup(id, machine = null) {
  pendingGroupSpaces.push({ id, machine, at: Date.now() });
  wakeGroupSpaces?.();
}

function defaultGroupFor(machine, data) {
  return {
    id: DEFAULT_GROUP,
    name: "default",
    machine: machine ?? null,
    folded: Boolean(data.defaultFolded?.[machine ?? ""]),
    virtual: true,
  };
}

function removeFromGroups(data, id) {
  for (const list of Object.values(data.in)) {
    const at = list.indexOf(id);
    if (at !== -1) list.splice(at, 1);
  }
}

function panesByTab(ps) {
  const byTab = new Map();
  for (const p of ps) {
    let list = byTab.get(p.tab);
    if (!list) byTab.set(p.tab, list = []);
    list.push(p);
  }
  return byTab;
}

function programFor(w, tabPanes) {
  let activePane = null;
  let first = null;
  for (const tab of w.tabs ?? []) {
    for (const p of tabPanes.get(tab.id) ?? []) {
      if (!p.terminal) continue;
      if (p.focused) return p;
      if (!activePane && tab.active) activePane = p;
      if (!first) first = p;
    }
  }
  return activePane ?? first;
}

function programIcon(p, t) {
  return iconChip(p, t, { slot: 20, max: 18, empty: true });
}

export default class Spaces extends View {
  init(_props, cx) {
    const p = props() ?? _props ?? {};
    if (p.role === "prompt") {
      this.prompt = p;
      this.input = InputState.new({ value: p.value ?? "", placeholder: "Group name" });
      this.input.set_selected_range({ start: 0, end: this.input.value().length });
      this.input.on("change", (_e, cx) => cx.notify());
      this.input.on("submit", () => this.submitPrompt());
      this.inputFocused = true;
      this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
      this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
      this.input.focus();
      cx.timer.after(300, () => this.input.focus());
      this.handle = cx.focus_handle();
      return;
    }
    if (p.role === "menu") {
      this.menuProps = p;
      this.at = 0;
      this.menuPointer = false;
      this.handle = cx.focus_handle();
      this.handle.focus();
      return;
    }
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.overGroup = null;
    this.overGroupMachine = null;
    this.ringKey = null; // the group header whose drop ring has waited long enough
    this.ringMachine = null;
    this.ringToken = null;
    this.overUngroup = false;
    this.positionOf = {};
    this.seen = [];
    this.listItems = []; // what each child of the list shows, in order (see grouped)
    this.caption = null; // { machine, head }: the rows in view belong to a machine whose header has left the list
    this.pointer = null; // where the pointer is in the list, while a row is dragged
    this.edgeDir = 0; // -1, 0 or 1: the edge a dragged row is held at
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.listHeight = -1; // last viewport height, so only a real height change reveals the active row
    this.wheelAt = 0; // when this list last took a wheel; a size change right after must not yank it back
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    try { this.parkedFolded = new Set(JSON.parse(localStorage.getItem(PARKED_FOLDED_KEY) ?? "[]")); } catch { this.parkedFolded = new Set(); }
    this.handle = cx.focus_handle();
    this.known = new Map(); // id -> the last shape a space had, so a close can leave a Parked project
    this.orderAll = []; // the full drawn order, before any filter
    this.lastActive = null;
    this.filtering = false;
    this.filterText = "";
    this.filterFocused = false;
    this.filterAt = 0;
    this.filterPickId = null;
    this.filterInput = InputState.new({ value: "", placeholder: "Filter spaces" });
    this.filterInput.on("change", (_e, cx) => {
      this.filterText = this.filterInput.value();
      this.filterAt = 0;
      this.filterPickId = null;
      cx.notify();
    });
    this.filterInput.on("submit", (_e, cx) => this.chooseFiltered(cx));
    this.filterInput.on("focus", (_e, cx) => { this.filterFocused = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.filterFocused = false; cx.notify(); });
    this.notice = null;
    const firstLook = Date.now();
    for (const space of spaces()) this.known.set(space.id, this.knownSpace(space, firstLook));
    this.lastActive = spaces().find((space) => space.active)?.id ?? null;
    if (!checking()) {
      groupSync.owners.add(this);
      startGroupSync(cx);
      this.refreshMachines(cx);
      cx.timer.every(15000, cx => this.refreshMachines(cx));
      // Refresh only when the refs could have changed (see `due`).
      cx.timer.every(250, (cx) => this.checkNew(cx));
      cx.spawn(async (cx) => {
        for (;;) {
          const c = String(await nextCommand()).split(".").pop();
          if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1);
          else if (/^select[1-9]$/.test(c)) this.selectSeen(Number(c.slice(6)));
          else if (c === "filter") this.toggleFilter(cx);
          else if (c === "new-space") this.newSpaceHere(cx);
          else if (c === "menu") {
            const active = spaces().find((space) => space.active);
            if (active) this.menu(active, "dialog");
          } else if (c === "new-group") this.openGroupPrompt(spaces().find((space) => space.active)?.machine ?? null);
          cx.notify();
        }
      });
      cx.spawn(async (cx) => {
        for (;;) {
          while (pendingGroupSpaces.length) {
            const req = pendingGroupSpaces.shift();
            if (Date.now() - req.at > 5000) continue;
            const group = readStore().groups.find((g) => g.id === req.id);
            if (group) this.newSpaceInGroup(group, req.machine ?? group.machine ?? null, cx);
          }
          await new Promise((resolve) => { wakeGroupSpaces = resolve; });
          wakeGroupSpaces = null;
        }
      });
      // Read-only: a tiny manifest on GitHub, every six hours. The chip and the
      // notification open kent-updater; this mod never writes installed files.
      const checkUpdate = (cx) => cx.spawn(async (cx) => {
        try { await checkKentUpdate(); } catch {}
        cx.notify();
      });
      checkUpdate(cx);
      cx.timer.every(6 * 3600 * 1000, checkUpdate);
    }
  }

  step(dir) {
    const seen = this.seen ?? [];
    if (!seen.length) return;
    const active = spaces().find((w) => w.active)?.id;
    const at = seen.findIndex((id) => id === active);
    const from = at >= 0 ? at : dir > 0 ? -1 : seen.length;
    const next = seen[(((from + dir) % seen.length) + seen.length) % seen.length];
    if (next) run("space.select", { id: next });
  }

  // kent.select1 … kent.select9 (ctrl-1 … ctrl-9): the Nth row as the sidebar shows it,
  // the number the rail prints, where Herdr's own space.select goes by its inner order.
  selectSeen(n) {
    const id = (this.seen ?? [])[n - 1];
    if (id) run("space.select", { id });
  }

  knownSpace(space, at = Date.now(), folder = space.folder) {
    return {
      id: space.id,
      machine: space.machine ?? null,
      folder: folder ?? null,
      name: space.name ?? "",
      named: Boolean(space.named),
      at,
    };
  }

  filterActive() {
    return Boolean(this.filtering && this.filterText.trim());
  }

  rowMatches(row) {
    if (!this.filterActive()) return true;
    const space = row.w ?? row;
    const query = this.filterText.trim().toLocaleLowerCase();
    return [space.name, space.machine, row.g?.repo, row.g?.branch, space.folder]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
  }

  groupMatches(group) {
    if (!this.filterActive()) return true;
    return String(group.name ?? "").toLocaleLowerCase().includes(this.filterText.trim().toLocaleLowerCase());
  }

  projectMatches(project) {
    if (!this.filterActive()) return true;
    const query = this.filterText.trim().toLocaleLowerCase();
    return [project.name, project.folder].filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
  }

  toggleFilter(cx) {
    if (this.filtering) this.closeFilter(cx);
    else this.openFilter(cx);
  }

  openFilter(cx) {
    this.filtering = true;
    this.filterText = this.filterInput.value();
    this.filterAt = 0;
    this.filterPickId = null;
    this.filterFocused = true;
    this.filterInput.focus();
    cx.notify();
    cx.timer.after(80, () => { if (this.filtering) this.filterInput.focus(); });
  }

  closeFilter(cx, returnFocus = true) {
    this.filtering = false;
    this.filterText = "";
    this.filterAt = 0;
    this.filterPickId = null;
    this.filterFocused = false;
    this.filterInput.set_value("");
    this.filterInput.release();
    cx.notify();
    if (returnFocus) this.returnFocus();
  }

  chooseFiltered(cx) {
    if (!this.filterActive()) {
      this.closeFilter(cx, false);
      return;
    }
    const id = (this.seen ?? [])[this.filterAt];
    if (id) run("space.select", { id });
    this.closeFilter(cx, false);
  }

  moveFilter(dir, cx) {
    if (!this.filterActive()) return;
    const count = (this.seen ?? []).length;
    if (!count) return;
    this.filterAt = ((this.filterAt + dir) % count + count) % count;
    this.filterPickId = this.seen[this.filterAt] ?? null;
    const at = this.filterPickId ? this.positionOf[this.filterPickId] : undefined;
    if (at !== undefined) this.scroll.scroll_to_item(at);
    cx.notify();
  }

  handleFilterKey(event, cx) {
    if (!this.filtering) return false;
    const key = String(event.key ?? "").toLocaleLowerCase();
    if (key === "escape") {
      this.closeFilter(cx);
      cx.stop_propagation();
      return true;
    }
    if (key === "down" || key === "up") {
      this.moveFilter(key === "down" ? 1 : -1, cx);
      cx.stop_propagation();
      return true;
    }
    if (key === "enter") {
      if (this.filterFocused) return false; // the input's own submit handler already chooses
      this.chooseFiltered(cx);
      cx.stop_propagation();
      return true;
    }
    return false;
  }

  returnFocus() {
    const focused = panes().find((pane) => pane.focused);
    if (focused) run("pane.focus", { pane: focused.pane });
  }

  // The machine named by "Spaces" while the list shows a machine's rows without its
  // header. Checked after every scroll and now and then between, as a fold or a new
  // row moves the list without one.
  syncCaption(cx) {
    const next = this.captionFor();
    const now = this.caption;
    if (next?.machine === now?.machine && next?.head === now?.head) return;
    this.caption = next;
    cx.notify();
  }

  // A scroll has just been asked for: look once it has happened, however many came at once.
  soonCaption(cx) {
    if (this.captionSoon) return;
    this.captionSoon = true;
    cx.timer.after(50, (cx) => { this.captionSoon = false; this.syncCaption(cx); });
  }

  // The first child the top of the list shows, and the machine header above it. The
  // header is gone when its bottom is above the list's top; a header partly in view,
  // or one that is itself the first child shown, leaves the name to it.
  captionFor() {
    const items = this.listItems ?? [];
    if (!this.scroll) return null;
    const offset = this.scroll.offset().y;
    let top = 0;
    let headAt = -1;
    let headBottom = 0;
    for (const [n, m] of items.entries()) {
      const bottom = top + ofItem(m);
      if (m.machineHead) { headAt = n; headBottom = bottom; }
      if (bottom > offset) {
        const hidden = headAt >= 0 && headBottom <= offset + 2 && (items[headAt].machine ?? null) === (m.machine ?? null);
        return hidden ? { machine: m.machine ?? null, head: headAt } : null;
      }
      top = bottom;
    }
    return null;
  }

  // The list child under the pointer, last seen while a row was dragged. Only inside
  // the list: its side gutters, past its ends, or over another mod is nobody's target.
  under() {
    const p = this.pointer;
    if (!p || !this.scroll || p.x < 8 || p.x > p.w - 8 || p.y < 0 || p.y > p.h) return null;
    const at = this.scroll.offset().y + p.y;
    let top = 0;
    for (const m of this.listItems ?? []) {
      top += ofItem(m);
      if (top > at) return m;
    }
    return null;
  }

  checkNew(cx) {
    startGroupSync(cx);
    const now = Date.now();
    const sp = spaces();
    const ps = panes();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    this.trackPresence(sp, ps, machines(), cx);
    // Dead ids are pruned here at most once a minute, and inline with every
    // membership write; a core write only happens when something was removed.
    if (now - (this.prunedAt ?? 0) > PRUNE_EVERY) {
      this.prunedAt = now;
      this.pruneStoreData();
    }
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
    this.syncCaption(cx);
  }

  // A space that disappears while its machine is ready was closed, not hidden by
  // an offline machine. Its last folder becomes a Parked project; if it was the
  // active space, Kent picks the row just above it instead of whatever Herdr chose.
  trackPresence(sp, ps, ms, cx) {
    if (checking()) return;
    const live = new Set(sp.map((s) => s.id));
    const now = Date.now();
    let changed = false;
    for (const [id, old] of this.known) {
      if (live.has(id)) continue;
      const machine = old.machine ?? null;
      if (!machineReady(ms, machine)) continue;
      const group = this.groupOf(id, machine) ?? null;
      if (rememberProject({ ...old, group, at: now })) changed = true;
      if (this.lastActive === id) this.closeToNeighbor(id, cx);
    }
    this.known = new Map(sp.map((s) => [s.id, this.knownSpace(s, now, place(s, ps))]));
    const active = sp.find((s) => s.active)?.id ?? null;
    if (active) this.lastActive = active;
    // The record is what feeds the Parked drawer; Herdr's own space change may
    // already have redrawn the list, but it was drawn before this record existed.
    if (changed) cx.notify();
  }

  closeToNeighbor(id, cx) {
    if (this.filterActive()) return;
    const seen = (this.prevSeen ?? []).includes(id) ? this.prevSeen : (this.seen ?? []);
    const orderAll = (this.prevOrderAll ?? []).includes(id) ? this.prevOrderAll : (this.orderAll ?? []);
    const visibleAt = seen.indexOf(id);
    let fallback = null;
    if (visibleAt >= 0) {
      // The drawn order is the one the eye is using; `orderAll` is Herdr's
      // order and can differ from a named group's `in` order.
      fallback = seen[visibleAt - 1] ?? seen[visibleAt + 1] ?? null;
    } else {
      const at = orderAll.indexOf(id);
      if (at >= 0) {
        for (let i = at - 1; i >= 0 && !fallback; i -= 1) {
          if (seen.includes(orderAll[i])) fallback = orderAll[i];
        }
        for (let i = at + 1; i < orderAll.length && !fallback; i += 1) {
          if (seen.includes(orderAll[i])) fallback = orderAll[i];
        }
      }
    }
    if (!fallback) return;
    // Herdr has its own idea of the next space; let the close settle, then use
    // the row above the one that closed, which is where the eye already is.
    cx.timer.after(300, () => {
      if (!spaces().some((s) => s.id === fallback)) return;
      if (spaces().find((s) => s.active)?.id === fallback) return;
      run("space.select", { id: fallback });
    });
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window()?.active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    if (!key) return [];
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && String(machine.why ?? "").includes("a different core answers there (\"");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        // A rebuilt machine has a new core and therefore an empty group
        // document. Let the compatibility snapshot migrate onto it again;
        // pending intents stay queued and replay harmlessly on top.
        groupSync.stores.delete(name);
        resetMigrationDone(name);
        resetRememberedDocVersion(name);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        while (this.pending.size) {
          const keys = [...this.pending];
          this.pending.clear();
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
            while (next < keys.length) await this.check(keys[next++], cx);
          }));
        }
      } finally {
        // A failing look must not leave the flag set for the rest of the session.
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    let on, cwd;
    try { [on, cwd] = JSON.parse(key); } catch { return; }
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const name = repoName(repo);
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  clearDrag() {
    this.pressed = null;
    this.over = null;
    this.overGroup = null;
    this.overGroupMachine = null;
    this.ringKey = null;
    this.ringMachine = null;
    this.ringToken = null;
    this.overUngroup = false;
    // The edge loop stops on this; the next drag decides its own edge from zero.
    this.edgeDir = 0;
  }

  // A dragged row let go with the row `target` under the pointer: it goes into target's
  // group, before or after it, and in the default group is also re-sorted in Herdr's
  // own order (where before-or-after means something).
  dropOn(from, target) {
    const spNow = spaces();
    const source = spNow.find(s => s.id === from);
    if (!source) return;
    const sourceGroup = this.groupOf(from, source.machine ?? null);
    const targetGroup = this.groupOf(target, source.machine ?? null);
    const fromIdx = spNow.findIndex(s => s.id === from);
    const targetIdx = spNow.findIndex(s => s.id === target);
    const after = (this.positionOf[from] ?? fromIdx) < (this.positionOf[target] ?? targetIdx);
    const moveInDefault = () => {
      if (fromIdx === -1 || targetIdx === -1) return;
      const adj = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
      const dest = adj + (after ? 2 : 1);
      if (dest !== fromIdx + 1) run("space.move", { id: from, index: dest });
    };
    if (targetGroup !== null || sourceGroup !== null) {
      this.assignToGroup(from, targetGroup, target, after);
      if (targetGroup === null) moveInDefault();
    } else moveInDefault();
  }

  // What letting go over the list child `m` means. A row takes the dragged one before or
  // after itself; a group's header into its group; "Move to default" out of every group.
  // A machine's own header, a loading row, or anything on another machine takes nothing.
  dropOnItem(from, m) {
    const source = spaces().find(s => s.id === from);
    if (!source || !m || (m.machine ?? null) !== (source.machine ?? null)) return;
    if (m.id) { if (m.id !== from) this.dropOn(from, m.id); }
    else if (m.groupHead) { this.groupDropAt = Date.now(); this.assignToGroup(from, m.virtual ? null : m.group); }
    else if (m.drop) this.assignToGroup(from, null);
  }

  // The pointer moved while a row is dragged. Event positions count from the list's
  // own top, the one scroll.offset() counts. Held near an edge, the list scrolls that
  // way for as long as the row stays there (see runEdge).
  edgeFollow(e, cx) {
    if (this.pressed === null || e.pressed_button !== "left" || !e.local_position || !e.bounds) return;
    const zoom = Number(settings().zoom) || 1;
    const y = e.local_position.y / zoom;
    // The viewport, not the element's box: another block can share the column below and
    // the box runs on behind it, which put the bottom edge past the rows you can see.
    const height = this.scroll ? this.scroll.viewport_size().height : e.bounds.height / zoom;
    this.pointer = { x: e.local_position.x / zoom, y, w: e.bounds.width / zoom, h: height };
    const dir = y >= -EDGE && y < EDGE ? -1 : y <= height + EDGE && y > height - EDGE ? 1 : 0;
    if (dir === this.edgeDir) return;
    this.edgeDir = dir;
    if (dir) { if (!this.edgeTask) this.runEdge(cx); }
    // Off the edge: the row under the pointer may have changed since the list last moved.
    else cx.timer.after(60, (cx) => { if (this.retarget(cx)) cx.notify(); });
  }

  // One child past the edge every 90ms, until the pointer leaves the edge, the row is
  // let go, or the list has no more that way.
  runEdge(cx) {
    cx.spawn(async (cx) => {
      try {
        while (this.edgeDir && this.pressed !== null) {
          await cx.sleep(90);
          if (!this.edgeDir || this.pressed === null) break;
          if (this.retarget(cx)) cx.notify();
          if (!this.scrollEdge(this.edgeDir)) await cx.sleep(250);
        }
      } finally { this.edgeTask = false; }
    });
    this.edgeTask = true;
  }

  // Scroll the first child hidden past the `dir` edge into view. False at the list's end.
  scrollEdge(dir) {
    if (!this.scroll) return false;
    const offset = this.scroll.offset().y;
    const view = this.scroll.viewport_size().height;
    let top = 0;
    let first = -1;
    let last = -1;
    let n = 0;
    for (const m of this.listItems ?? []) {
      const bottom = top + ofItem(m);
      if (first === -1 && bottom > offset) first = n;
      if (top < offset + view) last = n;
      top = bottom;
      n += 1;
    }
    const target = dir < 0 ? first - 1 : last + 1;
    if (target < 0 || target >= n) return false;
    this.scroll.scroll_to_item(target);
    return true;
  }

  // A header's drop ring is armed by a timer, not by when a frame happens to be drawn:
  // it shows only once the pointer has stayed on that header long enough.
  ringFor(gid, machine, cx) {
    if (this.ringKey === gid && this.ringMachine === machine) return;
    this.ringKey = null;
    this.ringMachine = machine;
    const token = (this.ringToken = {});
    cx.timer.after(RING_DELAY, (cx) => {
      if (this.ringToken !== token) return;
      this.ringKey = gid;
      this.ringMachine = machine;
      cx.notify();
    });
  }

  // Off a header the wait starts over.
  ringReset() {
    this.ringKey = null;
    this.ringMachine = null;
    this.ringToken = null;
  }

  // The list moved under a pointer that didn't: say which row is under it now, as a
  // move over that row would have. True when that changed the drop target.
  retarget(cx) {
    if (this.pressed === null) return false;
    const m = this.under();
    const source = spaces().find(s => s.id === this.pressed);
    const mine = Boolean(source && m && (m.machine ?? null) === (source.machine ?? null));
    const over = mine && m.id ? m.id : null;
    const overGroup = mine && m.groupHead && over === null ? m.group : null;
    const overGroupMachine = overGroup === null ? null : (m.machine ?? null);
    const overUngroup = Boolean(mine && m.drop);
    if (this.over === over && this.overGroup === overGroup && this.overGroupMachine === overGroupMachine && this.overUngroup === overUngroup) return false;
    // On a header, the ring waits; anywhere else it is dropped at once.
    if (overGroup !== null && over === null) this.ringFor(overGroup, overGroupMachine, cx);
    else this.ringReset();
    this.over = over;
    this.overGroup = overGroup;
    this.overGroupMachine = overGroupMachine;
    this.overUngroup = overUngroup;
    return true;
  }

  // Beside "Spaces" while the rows in view belong to a machine whose header has left
  // the list; a click brings that header back.
  machineTag(t) {
    const m = this.caption?.machine ?? null;
    return h_flex()
      .h(20)
      .flex_none()
      .max_w(132)
      .px(6)
      .gap(5)
      .items_center()
      .rounded(5)
      .bg(t.raised)
      .text_size(11)
      .text_color(t.muted)
      .cursor_pointer()
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`The rows in view are on ${m ?? "this computer"}. Click for its header.`)
      .on_click(() => this.scroll.scroll_to_item(this.caption?.head ?? 0))
      .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(11).flex_none())
      .child(div().min_w(0).truncate().font_semibold().child(m ?? "This computer"));
  }

  groupsFor(machine, data = readStore()) {
    return data.groups.filter((g) => (g.machine ?? null) === (machine ?? null));
  }

  machineOfGroup(id, data = readStore()) {
    const group = data.groups.find((g) => g.id === id);
    return group ? (group.machine ?? null) : undefined;
  }

  machineForSpace(spaceId, targetGroup = null) {
    const space = spaces().find((s) => s.id === spaceId);
    if (space) return space.machine ?? null;
    if (targetGroup) {
      const machine = this.machineOfGroup(targetGroup);
      if (machine !== undefined) return machine;
    }
    for (const machine of syncMachineNames()) {
      if (machine && spaceId.startsWith(`${machine}/`)) return machine;
    }
    return null;
  }

  // Prune dead canonical ids machine by machine. Each operation is small and
  // returns null when the machine is offline or nothing is dead, so the core
  // document is not rewritten merely because the timer fired.
  pruneStoreData() {
    let queued = false;
    for (const st of [...groupSync.stores.values()]) {
      if (!st.data.groups.length) continue;
      const machine = st.machine;
      const draft = copyMachineData(st.data);
      if (!pruneMachineData(draft, machine)) continue;
      queued = enqueueGroupOp(machine, { type: "prune" }, { label: "prune closed spaces" }) || queued;
    }
    return queued;
  }

  groupOf(spaceId, machine, data = readStore()) {
    for (const g of data.groups) {
      if ((g.machine ?? null) !== (machine ?? null)) continue;
      if ((data.in[g.id] ?? []).includes(spaceId)) return g.id;
    }
    return null;
  }

  createGroup(name, machine, spaceId = null) {
    machine = machine ?? null;
    const id = groupId();
    const bare = spaceId ? bareSpaceId(spaceId, machine) : null;
    enqueueGroupOp(machine, { type: "create", id, name, space: bare }, { label: "create group" });
  }

  renameGroup(id, name) {
    const machine = this.machineOfGroup(id);
    if (machine === undefined) return;
    enqueueGroupOp(machine, { type: "rename", id, name }, { label: "rename group" });
  }

  deleteGroup(id) {
    const machine = this.machineOfGroup(id);
    if (machine === undefined) return;
    enqueueGroupOp(machine, { type: "delete", id }, { label: "delete group" });
  }

  toggleGroup(id, machine = null) {
    if (id === DEFAULT_GROUP) {
      machine = machine ?? null;
      const wanted = !machineStore(machine).data.defaultFolded;
      enqueueGroupOp(machine, { type: "fold", defaultGroup: true, folded: wanted }, { label: "fold default group" });
      return;
    }
    machine = this.machineOfGroup(id);
    if (machine === undefined) return;
    const current = machineStore(machine).data.groups.find((g) => g.id === id);
    if (!current) return;
    const wanted = !current.folded;
    enqueueGroupOp(machine, { type: "fold", id, folded: wanted }, { label: "fold group" });
  }

  moveGroup(id, dir) {
    const machine = this.machineOfGroup(id);
    if (machine === undefined) return;
    const current = machineStore(machine).data.groups;
    const from = current.findIndex((g) => g.id === id);
    const wanted = from + dir;
    if (from === -1 || wanted < 0 || wanted >= current.length) return;
    // Capture the neighbour this move swaps past, not merely an absolute index.
    // Retrying against a newer document can then survive independent inserts or
    // deletes elsewhere in the list without landing in the wrong place.
    const anchor = current[wanted].id;
    const afterAnchor = dir > 0;
    enqueueGroupOp(machine, { type: "move", id, anchor, afterAnchor }, { label: "move group" });
  }

  assignToGroup(spaceId, targetGroup, targetId = null, after = true) {
    const machine = this.machineForSpace(spaceId, targetGroup);
    const bare = bareSpaceId(spaceId, machine);
    const bareTarget = targetId ? bareSpaceId(targetId, machine) : null;
    enqueueGroupOp(machine, {
      type: "assign",
      space: bare,
      targetGroup: targetGroup ?? null,
      targetId: bareTarget,
      after: Boolean(after),
    }, { label: "assign group" });
  }

  setGroupFolded(id, machine, folded) {
    if (id === DEFAULT_GROUP) {
      machine = machine ?? null;
      enqueueGroupOp(machine, { type: "fold", defaultGroup: true, folded: Boolean(folded) }, { label: "fold default group" });
      return;
    }
    machine = machine ?? this.machineOfGroup(id);
    if (machine === undefined) return;
    enqueueGroupOp(machine, { type: "fold", id, folded: Boolean(folded) }, { label: "fold group" });
  }

  createdSpace(before, machine) {
    const created = spaces().filter((space) => !before.has(space.id) && (space.machine ?? null) === (machine ?? null));
    return created.find((space) => space.active) ?? created.at(-1) ?? null;
  }

  // The top "New space" button and its palette command: make the next space a
  // neighbour of the active one, in the same machine and group.
  newSpaceHere(cx) {
    const active = spaces().find((space) => space.active);
    const machine = active?.machine ?? null;
    const data = readStore();
    const memberGroup = active ? this.groupOf(active.id, machine, data) : null;
    const group = memberGroup
      ? data.groups.find((g) => g.id === memberGroup)
      : defaultGroupFor(machine, machineStore(machine).data);
    if (!group) return;
    this.newSpaceInGroup(group, machine, cx, active ? { afterId: active.id } : {});
  }

  async createSpaceInGroup(request, cx) {
    beginSpaceCreation(request.machine);
    try {
      const before = new Set(spaces().map((space) => space.id));
      const args = { machine: request.machine ?? "", focus: true };
      if (request.folder) args.folder = request.folder;
      if (request.name) args.name = request.name;
      run("space.new", args);
      let created = this.createdSpace(before, request.machine);
      // The document usually changes after the initiating event returns, not inside it.
      // Wait on GPUI's foreground executor; setTimeout is not available to mods.
      for (let attempt = 0; !created && attempt < 50; attempt += 1) {
        await cx.sleep(100);
        created = this.createdSpace(before, request.machine);
      }
      if (!created) {
        if (request.notice) this.showNotice(request.notice, cx);
        return;
      }
      this.assignToGroup(created.id, request.group, request.afterId ?? null, true);
      if (request.group == null && request.afterId) {
        const target = spaces().findIndex((space) => space.id === request.afterId);
        const made = spaces().findIndex((space) => space.id === created.id);
        if (target >= 0 && made >= 0) {
          const dest = target + 2;
          if (dest !== made + 1) run("space.move", { id: created.id, index: dest });
        }
      }
      if (request.parkKey) forgetProject(request.parkKey.machine, request.parkKey.folder);
      if (request.unfold) this.setGroupFolded(request.group ?? DEFAULT_GROUP, request.machine, false);
      cx.notify();
    } finally {
      endSpaceCreation(request.machine);
    }
  }

  showNotice(text, cx) {
    this.notice = { text, until: Date.now() + 4500 };
    cx.notify();
    cx.timer.after(4600, () => {
      if (this.notice && Date.now() >= this.notice.until) { this.notice = null; cx.notify(); }
    });
  }

  // Space creation does not return the new id. Serialize requests so a quick
  // second click cannot make two pending creations race for the same diff.
  newSpaceInGroup(g, machine = g.machine ?? null, cx, options = {}) {
    if (g.virtual && !options.folder && !options.name && !options.afterId) {
      run("space.new", { machine: machine ?? "", focus: true });
      if (g.folded) this.setGroupFolded(g.id, machine, false);
      return;
    }
    const request = {
      group: g.virtual ? null : g.id,
      machine: machine ?? null,
      unfold: Boolean(g.folded),
      ...options,
    };
    this.newSpaceRequests ??= [];
    this.newSpaceRequests.push(request);
    if (this.newSpaceWorker) return;
    this.newSpaceWorker = true;
    cx.spawn(async (cx) => {
      try {
        while ((this.newSpaceRequests ?? []).length) {
          await this.createSpaceInGroup(this.newSpaceRequests.shift(), cx);
        }
      } finally {
        this.newSpaceWorker = false;
      }
    });
  }

  openGroupPrompt(machine, id = null, spaceId = null) {
    const group = id ? readStore().groups.find((g) => g.id === id) : null;
    openOverlay({
      mod: "kent",
      kind: "dialog",
      width: 360,
      height: 200,
      props: { role: "prompt", machine: machine ?? null, group: id, value: group?.name ?? "", spaceId },
    });
  }

  close() {
    this.input?.release();
    this.filterInput?.release();
    if (groupSync.owners.delete(this) && !groupSync.owners.size) stopGroupSync();
  }

  // Why the prompt can't be submitted right now: nothing but whitespace, or a
  // same-named group on this machine (the group being renamed doesn't count).
  promptProblem() {
    const p = this.prompt ?? {};
    const name = (this.input?.value() ?? "").trim();
    if (!name) return null;
    const machine = p.machine ?? null;
    const clash = readStore().groups.find((g) => (g.machine ?? null) === machine && g.id !== p.group && g.name === name);
    return clash ? `A group named “${name}” already exists` : null;
  }

  submitPrompt() {
    const p = this.prompt ?? {};
    const name = this.input.value().trim();
    if (!name || this.promptProblem()) return;
    closeOverlay(p.overlay);
    if (p.group) this.renameGroup(p.group, name);
    else this.createGroup(name, p.machine ?? null, p.spaceId ?? null);
  }

  menu(w, kind = "popup") {
    const git = this.git?.[where(w, panes())] ?? null;
    openOverlay({
      mod: "kent",
      kind,
      width: 238,
      props: { role: "menu", kind: "space", id: w.id, machine: w.machine ?? null, git: git ? { linked: !!git.linked } : null },
    });
  }

  groupMenu(g, machine) {
    openOverlay({
      mod: "kent",
      kind: "popup",
      width: 220,
      props: { role: "menu", kind: "group", id: g.id, machine: machine ?? null },
    });
  }

  orderingDue(now, ms = machines()) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machineReady(ms, name));
  }

  // Spaces in order. Herdr's rule — a linked worktree sits under its main
  // checkout — only applies inside the default group: a worktree filed into a
  // named group is left where the person put it, and the group itself decides
  // whether it nests (see groupTrees). Only loose rows ever trigger space.move.
  ordered(sp = spaces(), ps = panes(), ms = machines(), store = readStore()) {
    const now = Date.now();
    const list = sp.map((w, i) => {
      const k = where(w, ps);
      if (!this.shown.has(w.id) && (k in this.git || now - (this.born[w.id] ??= now) > 1500)) this.shown.add(w.id);
      return { w, i, g: this.git[k] ?? null };
    });
    const rowById = new Map(list.map((r) => [r.w.id, r]));
    // A space claimed by a named group of its own machine is out of the
    // default group's hands: no forced move, no tree lines from here.
    const claimed = new Set();
    for (const g of store.groups) {
      for (const id of store.in[g.id] ?? []) {
        const row = rowById.get(id);
        if (row && (row.w.machine ?? null) === (g.machine ?? null)) claimed.add(id);
      }
    }
    const looseMains = new Set(list.filter((r) => !claimed.has(r.w.id) && r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => !claimed.has(r.w.id) && r.g?.linked && looseMains.has(r.g.repo);
    const kidsByMain = new Map();
    for (const r of list) {
      if (!nested(r)) continue;
      const kids = kidsByMain.get(r.g.repo) ?? [];
      kids.push(r);
      kidsByMain.set(r.g.repo, kids);
    }
    // The arrangement is a permutation of the current order: loose worktrees
    // move under their main checkout, every other space keeps its place, so a
    // grouped space is never pulled around by someone else's nesting.
    const order = sp.map(w => w.id);
    const target = [];
    const treeOf = new Map();
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const id of order) {
      const row = rowById.get(id);
      if (!row || nested(row)) continue;
      target.push(id);
      if (!row.g || row.g.linked || claimed.has(id) || placed.has(row.g.repo)) continue;
      placed.add(row.g.repo);
      const kids = kidsByMain.get(row.g.repo) ?? [];
      kids.forEach((k, n) => {
        target.push(k.w.id);
        treeOf.set(k.w.id, n === kids.length - 1 ? "└─" : "├─");
      });
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const key = JSON.stringify([order, target, ms]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(now, ms)) {
      const moved = new Set();
      this.ordering = { key, at: now, machines: [] };
      for (let i = 0; i < target.length; i++) {
        const from = order.indexOf(target[i]);
        if (from === i) continue;
        run("space.move", { id: target[i], index: i + 1 });
        moved.add(rowById.get(target[i]).w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return target.map((id) => ({ ...rowById.get(id), tree: treeOf.get(id) ?? null })).filter((r) => this.shown.has(r.w.id));
  }

  // Tree lines inside a named group: a linked worktree nests only while it
  // sits in an unbroken run right under its main checkout in the same group.
  // Anything else in the group is an ordinary row, however it sorts elsewhere.
  groupTrees(members) {
    const trees = new Array(members.length).fill(null);
    let i = 0;
    while (i < members.length) {
      const r = members[i];
      if (r.g && !r.g.linked) {
        const kids = [];
        let j = i + 1;
        while (j < members.length && members[j].g?.linked && members[j].g.repo === r.g.repo) {
          kids.push(j);
          j += 1;
        }
        kids.forEach((at, n) => { trees[at] = n === kids.length - 1 ? "└─" : "├─"; });
        i = j;
      } else i += 1;
    }
    return members.map((r, n) => ({ ...r, tree: trees[n] }));
  }

  // `base` is how many visible rows the machines above have: a row's `base + its place`
  // is the number the rail prints and the one ctrl-N goes by. `meta` says what each
  // returned child shows and how tall it is (see ofItem).
  machineRows(machine, mine, draw, t, collapsed, data, base = 0, parked = []) {
    const positions = new Map();
    const visible = [];
    const meta = [];
    if (collapsed) {
      const shown = this.filterActive() ? mine.filter((r) => this.rowMatches(r)) : mine;
      const items = shown.map((r, i) => {
        positions.set(r.w.id, i);
        this.positionOf[r.w.id] = i;
        visible.push(r.w.id);
        meta.push({ id: r.w.id, machine, h: 26 });
        return draw({ ...r, group: null }, base + i);
      });
      return { items, positions, visible, meta };
    }
    const rowById = new Map(mine.map((r) => [r.w.id, r]));
    const groups = data.groups.filter((g) => (g.machine ?? null) === (machine ?? null));
    const claimed = new Map();
    for (const g of groups) {
      for (const id of data.in[g.id] ?? []) {
        if (rowById.has(id) && !claimed.has(id)) claimed.set(id, g.id);
      }
    }
    const filtering = this.filterActive();
    const entries = [];
    let at = 0;
    for (const g of groups) {
      const allIds = (data.in[g.id] ?? []).filter((id) => rowById.has(id) && claimed.get(id) === g.id);
      // A group-name hit keeps the whole group: matching only its header and
      // showing an empty shelf would be a worse answer than showing the shelf.
      const hit = filtering && this.groupMatches(g);
      const ids = filtering && !hit ? allIds.filter((id) => this.rowMatches(rowById.get(id))) : allIds;
      if (filtering && !ids.length) continue;
      const members = this.groupTrees(ids.map((id) => rowById.get(id)));
      entries.push({ kind: "head", g, members, total: allIds.length });
      at += 1;
      if (g.folded) continue;
      for (const r of members) {
        positions.set(r.w.id, at);
        this.positionOf[r.w.id] = at;
        visible.push(r.w.id);
        entries.push({ kind: "row", r, group: g.id, n: base + visible.length - 1 });
        at += 1;
      }
    }
    const looseAll = mine.filter((row) => !claimed.has(row.w.id));
    const fallback = defaultGroupFor(machine, data);
    const defaultHit = filtering && this.groupMatches(fallback);
    const loose = filtering && !defaultHit ? looseAll.filter((row) => this.rowMatches(row)) : looseAll;
    // No loose rows means no default header: an empty header would only offer a
    // fold toggle over nothing, and every create path unfolds default first.
    if (loose.length) {
      if (groups.length > 0 || fallback.folded) {
        entries.push({ kind: "head", g: fallback, members: loose, total: looseAll.length });
        at += 1;
      }
      if (!fallback.folded) {
        for (const r of loose) {
          positions.set(r.w.id, at);
          this.positionOf[r.w.id] = at;
          visible.push(r.w.id);
          entries.push({ kind: "row", r, group: null, n: base + visible.length - 1 });
          at += 1;
        }
      }
    }
    if (parked.length) {
      const folded = this.parkedFolded.has(machine ?? "");
      entries.push({ kind: "parked-head", count: parked.length, folded });
      if (!folded) for (const [index, project] of parked.entries()) {
        entries.push({ kind: "parked", project, index });
      }
    }
    const items = [];
    for (const entry of entries) {
      if (entry.kind === "head") {
        items.push(this.groupHead(entry.g, entry.members, machine, t, entry.total));
        meta.push({ groupHead: true, group: entry.g.id, virtual: Boolean(entry.g.virtual), machine, h: 30 });
      } else if (entry.kind === "parked-head") {
        items.push(this.parkedHead(machine, entry.count, entry.folded, t));
        meta.push({ parkedHead: true, machine, h: 30 });
      } else if (entry.kind === "parked") {
        items.push(this.parkedRow(entry.project, machine, t, entry.index));
        meta.push({ parked: true, machine, h: 28 });
      } else {
        items.push(draw({ ...entry.r, group: entry.group }, entry.n));
        meta.push({ id: entry.r.w.id, group: entry.group, machine, h: rowHeight(entry.r) });
      }
    }
    return { items, positions, visible, meta };
  }

  groupHead(g, members, machine, t, total = members.length) {
    const counts = { working: 0, blocked: 0, done: 0 };
    for (const r of members) if (counts[r.w.status] !== undefined) counts[r.w.status] += 1;
    const sameMachine = (this.overGroupMachine ?? null) === (machine ?? null);
    // A ring that shows at once flickers under every glance a drag takes across a
    // header on its way past; hold still on it for a moment and it is a target.
    const rested = this.ringKey === g.id && this.ringMachine === (machine ?? null);
    const highlighted = this.pressed !== null && this.overGroup === g.id && this.over === null && sameMachine && rested;
    const countsTip = [
      counts.blocked ? `${counts.blocked} blocked` : null,
      counts.done ? `${counts.done} done` : null,
      counts.working ? `${counts.working} working` : null,
    ].filter(Boolean).join(", ");
    return h_flex()
      .id(`kent-group-${machine ?? "local"}-${g.id}`)
      .h(24)
      .mt(5)
      .mb(1)
      .px(8)
      .gap(7)
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(highlighted ? t.accent : "#00000000")
      .when(highlighted, (el) => el.bg(t.selected))
      .when(!highlighted, (el) => el.hover((s) => s.bg(t.hover)))
      .text_size(11)
      .font_semibold()
      .text_color(t.dim)
      .cursor_pointer()
      .tooltip(countsTip ? `${g.name}: ${countsTip}` : g.name)
      .on_click(() => {
        if (Date.now() - (this.groupDropAt ?? 0) < 250) return;
        this.toggleGroup(g.id, machine);
      })
      .on_mouse_down("right", () => { if (!g.virtual) this.groupMenu(g, machine); })
      .on_mouse_move((e, cx) => {
        if (this.pressed === null) return;
        if (e.pressed_button !== "left") {
          this.clearDrag();
          cx.notify();
          return;
        }
        const source = spaces().find((s) => s.id === this.pressed);
        if (!source || (source.machine ?? null) !== (machine ?? null)) return;
        if (this.over !== null || this.overGroup !== g.id || (this.overGroupMachine ?? null) !== (machine ?? null) || this.overUngroup) {
          this.over = null;
          this.overGroup = g.id;
          this.overGroupMachine = machine ?? null;
          this.overUngroup = false;
          this.ringFor(g.id, machine ?? null, cx);
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed === null) return;
        const from = this.pressed;
        const source = spaces().find((s) => s.id === from);
        this.clearDrag();
        this.groupDropAt = Date.now();
        if (source && (source.machine ?? null) === (machine ?? null)) {
          this.assignToGroup(from, g.virtual ? null : g.id);
        }
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/folder.svg").size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child(g.name))
      // A folded group is a closed drawer: it still says who is inside and
      // whether anyone needs you. Unfolded groups stay quiet; their rows show it.
      .when(g.folded && counts.working > 0, (el) => el.child(h_flex().flex_none().gap(1).items_center()
        .child(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(t.working).spin(900))
        .child(div().text_size(10).text_color(t.working).child(String(counts.working)))))
      .when(g.folded && counts.blocked > 0, (el) => el.child(div().flex_none().px(3).h(13).rounded(3)
        .bg(t.blocked + "22").text_size(9.5).font_bold().text_color(t.blocked).flex().items_center()
        .child(`!${counts.blocked}`)))
      .when(g.folded && counts.done > 0, (el) => el.child(h_flex().flex_none().gap(1).items_center()
        .child(div().text_size(8).text_color(t.done).child("●"))
        .child(div().text_size(10).text_color(t.done).child(String(counts.done)))))
      .child(div().flex_none().text_size(10.5).text_color(t.dim)
        .child(total !== members.length ? `${members.length}/${total}` : String(members.length)))
      .child(div().id(`kent-group-new-${machine ?? "local"}-${g.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`New space in ${g.name}`)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          const active = spaces().find((s) => s.active && (s.machine ?? null) === (machine ?? null));
          const store = readStore();
          const anchored = active && this.groupOf(active.id, machine, store) === (g.virtual ? null : g.id);
          this.newSpaceInGroup(g, machine, cx, anchored ? { afterId: active.id } : {});
        })
        .child(svg("mods/workspace-chrome/plus.svg").size(10)))
      .child(svg(`mods/workspace-chrome/chevron-${g.folded ? "right" : "down"}.svg`).size(10).flex_none().text_color(t.dim));
  }

  parkedFor(machine, sp, ps) {
    const entries = projectEntries(machine);
    if (!entries.length) return [];
    const open = new Set();
    for (const s of sp) {
      if ((s.machine ?? null) !== (machine ?? null)) continue;
      if (s.folder) open.add(normPath(s.folder));
      const live = place(s, ps);
      if (live) open.add(normPath(live));
    }
    const query = this.filterActive() ? this.filterText.trim().toLocaleLowerCase() : "";
    return entries.filter((p) => {
      if (open.has(normPath(p.folder))) return false;
      if (!query) return true;
      return [p.name, p.folder].filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
    });
  }

  parkedHead(machine, count, folded, t) {
    const key = machine ?? "";
    return h_flex()
      .id(`kent-parked-${machine ?? "local"}`)
      .h(24)
      .mt(5)
      .mb(1)
      .px(8)
      .gap(7)
      .items_center()
      .rounded(6)
      .hover((s) => s.bg(t.hover))
      .text_size(11)
      .font_semibold()
      .text_color(t.dim)
      .cursor_pointer()
      .tooltip("Closed spaces keep their folder here; click one to reopen it.")
      .on_click((_e, cx) => {
        if (folded) this.parkedFolded.delete(key);
        else this.parkedFolded.add(key);
        localStorage.setItem(PARKED_FOLDED_KEY, JSON.stringify([...this.parkedFolded]));
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/archive.svg").size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child("Parked"))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(String(count)))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(10).flex_none().text_color(t.dim));
  }

  parkedRow(project, machine, t, index) {
    const title = project.name || projectTail(project.folder);
    const tail = projectTail(project.folder);
    const showTail = title !== tail;
    return h_flex()
      .id(`kent-parked-row-${machine ?? "local"}-${index}`)
      .h(28)
      .px(8)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openParked(project, machine, cx))
      .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child(title).tooltip(project.folder))
      .when(showTail, (el) => el.child(div().max_w(86).flex_none().truncate().text_size(10.5).text_color(t.dim).child(tail)))
      .child(div()
        .id(`kent-parked-forget-${machine ?? "local"}-${index}`)
        .size(14)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(4)
        .text_size(11)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Forget this folder")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (forgetProject(machine, project.folder)) cx.notify();
        })
        .child(svg("mods/workspace-chrome/x.svg").size(8)));
  }

  openParked(project, machine, cx) {
    const store = readStore();
    const group = project.group && store.groups.find((g) => g.id === project.group && (g.machine ?? null) === (machine ?? null));
    const g = group ?? defaultGroupFor(machine, machineStore(machine).data);
    this.newSpaceInGroup(g, machine, cx, {
      folder: project.folder,
      name: project.named && project.name ? project.name : null,
      parkKey: { machine, folder: project.folder },
      notice: `Couldn't reopen ${project.name || projectTail(project.folder)} — is the folder still there?`,
    });
  }

  ungroupDrop(t, sp, store) {
    const source = sp.find((s) => s.id === this.pressed);
    if (!source || !this.groupOf(source.id, source.machine ?? null, store)) return null;
    const highlighted = this.pressed !== null && this.overUngroup;
    return h_flex()
      .id("kent-ungroup")
      .h(30)
      .mt(8)
      .px(8)
      .gap(7)
      .items_center()
      .rounded(7)
      .border_1()
      .border_dashed()
      .border_color(highlighted ? t.accent : t.border)
      .when(highlighted, (el) => el.bg(t.selected))
      .text_size(11.5)
      .text_color(t.dim)
      .on_mouse_move((e, cx) => {
        if (this.pressed === null) return;
        if (e.pressed_button !== "left") {
          this.clearDrag();
          cx.notify();
          return;
        }
        if (this.over !== null || this.overGroup !== null || this.overGroupMachine !== null || !this.overUngroup) {
          this.over = null;
          this.overGroup = null;
          this.overGroupMachine = null;
          this.overUngroup = true;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed === null) return;
        const from = this.pressed;
        this.clearDrag();
        this.assignToGroup(from, null);
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/folder.svg").size(12).flex_none())
      .child("Move to default");
  }

  // The rows, under a header per machine once one isn't this computer. Returns the list's
  // children as [element, what it shows and how tall it is], in order.
  grouped(t, collapsed, sp, ps, ms, store, tabPanes) {
    const rows = this.ordered(sp, ps, ms, store);
    // A close redraws the sidebar before checkNew sees the missing id. Keep the
    // previous drawing so the fallback can still find the row that was just there.
    this.prevSeen = this.seen ?? [];
    this.prevOrderAll = this.orderAll ?? [];
    this.orderAll = rows.map((r) => r.w.id);
    // `n`: the row's number among the visible ones (the rail prints it, ctrl-N goes by it).
    const draw = (r, n) => (collapsed ? this.compact(r, t, n) : this.row(r, t, sp, tabPanes));
    this.seen = [];
    this.positionOf = {};
    // Where the active space's row lands among the children this returns: the list scrolls by its direct
    // children, and machine headers, login notes and loading rows count too.
    this.activeAt = -1;
    let before = 0; // children above this machine's
    let base = 0; // visible rows above this machine's
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = ms.find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || sp.some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [[loadingRow(null), { machine: null, h: 28 }]];
      const parked = this.parkedFor(null, sp, ps);
      const packed = this.machineRows(null, rows, draw, t, collapsed, store, 0, parked);
      this.seen.push(...packed.visible);
      const active = rows.find((r) => r.w.active)?.w.id;
      this.activeAt = active ? packed.positions.get(active) ?? -1 : -1;
      return packed.items.map((el, n) => [el, packed.meta[n]]);
    }
    const out = [];
    for (const [machineIndex, m] of [null, ...remote].entries()) {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(6).text_size(11).font_semibold().text_color(t.muted)
        .when(!collapsed && machineIndex > 0, el => el.mt(6))
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, el => el.child(div().id(`machine-logout-${m}`)
          .flex_none().text_color(t.blocked).tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); }).child("⚠")))
        .child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge)))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el
            .child(div().id(`machine-group-${m ?? "local"}`).size(20).flex_none().flex().items_center().justify_center().rounded(5).hover(s => s.bg(t.hover).text_color(t.foreground))
              .tooltip("New group")
              .on_click((_e, cx) => { cx.stop_propagation(); this.openGroupPrompt(m); })
              .child(svg("mods/workspace-chrome/folder-plus.svg").size(11)))
            .child(div().id(`machine-add-${m ?? "local"}`).size(20).flex_none().flex().items_center().justify_center().rounded(5).hover(s => s.bg(t.hover).text_color(t.foreground))
              .tooltip("New space")
              .on_click((_e, cx) => { cx.stop_propagation(); this.newSpaceInGroup(defaultGroupFor(m, machineStore(m).data), m, cx); })
              .child(svg("mods/workspace-chrome/plus.svg").size(11))))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.newSpaceInGroup(defaultGroupFor(m, machineStore(m).data), m, cx))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) {
        before += 1;
        out.push([head, { machineHead: true, machine: m, h: 26 + (machineIndex > 0 ? 6 : 0) }]);
        continue;
      }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const packed = folded ? null : this.machineRows(m, mine, draw, t, collapsed, store, base, this.parkedFor(m, sp, ps));
      // A login note is two lines: its height here is an estimate.
      const content = !packed ? []
        : packed.items.length ? packed.items.map((el, n) => [el, packed.meta[n]])
        : [[loading(m) ? loadingRow(m) : cell(empty), { machine: m, h: 28 }]];
      const items = [[cell(head), { machineHead: true, machine: m, h: 26 + (collapsed ? 4 : machineIndex > 0 ? 6 : 0) }], ...guidance.map((el) => [el, { machine: m, h: 46 }]), ...content];
      if (packed) {
        this.seen.push(...packed.visible);
        base += packed.visible.length;
        const active = mine.find((r) => r.w.active)?.w.id;
        const position = active ? packed.positions.get(active) : undefined;
        if (position !== undefined) this.activeAt = before + 1 + guidance.length + position;
      }
      before += items.length;
      out.push(...items);
    }
    return out;
  }

  menuItems() {
    const p = this.menuProps ?? {};
    if (p.kind === "group") {
      const data = readStore();
      const group = data.groups.find((g) => g.id === p.id);
      if (!group) return [];
      // Moving is only offered where it can go: not past the first or last
      // group of the machine, and not at all when it is the only one.
      const own = this.groupsFor(group.machine ?? null, data);
      const at = own.findIndex((g) => g.id === p.id);
      const moves = [
        ...(at > 0 ? [{ label: "Move up", action: "group-up" }] : []),
        ...(at !== -1 && at < own.length - 1 ? [{ label: "Move down", action: "group-down" }] : []),
      ];
      return [
        { label: "New space in group", icon: "plus", action: "new-space" },
        { label: group.folded ? "Unfold group" : "Fold group", icon: "folder", action: "fold" },
        { label: "Rename group…", icon: "square-pen", action: "rename-group" },
        ...(moves.length ? [{ separator: true }, ...moves] : []),
        { separator: true },
        { label: "Delete group", icon: "x", action: "delete-group", danger: true },
      ];
    }
    const machine = p.machine ?? null;
    const data = readStore();
    const groups = this.groupsFor(machine, data);
    const current = this.groupOf(p.id, machine, data);
    const git = p.git ?? null;
    return [
      { label: "Open", icon: "terminal", action: "open" },
      { label: "Rename", icon: "square-pen", action: "rename" },
      ...(git ? [
        { label: "New worktree", icon: "git-branch", action: "worktree", worktree: "new" },
        { label: "Open worktree", icon: "git-branch", action: "worktree", worktree: "open" },
      ] : []),
      ...(git?.linked ? [{ label: "Remove worktree", icon: "git-branch", action: "worktree", worktree: "remove" }] : []),
      { separator: true },
      { label: "Move to default", icon: "folder", action: "assign", group: null, checked: !current },
      ...groups.map((g) => ({ label: `Move to ${g.name}`, icon: "folder", action: "assign", group: g.id, checked: current === g.id })),
      { label: "Group this space…", icon: "folder-plus", action: "new-group" },
      { separator: true },
      { label: "Close space", icon: "x", action: "close", danger: true },
    ];
  }

  moveMenu(dir) {
    const items = this.menuItems();
    if (!items.length) return;
    let at = this.at;
    for (let step = 0; step < items.length; step += 1) {
      at = (at + dir + items.length) % items.length;
      if (!items[at]?.separator) {
        this.at = at;
        return;
      }
    }
  }

  chooseMenu(i) {
    const it = this.menuItems()[i];
    const p = this.menuProps ?? {};
    if (!it || it.separator) return;
    closeOverlay(p.overlay);
    switch (it.action) {
      case "open": run("space.select", { id: p.id }); break;
      case "rename": run("space.rename", { id: p.id }); break;
      case "assign": this.assignToGroup(p.id, it.group ?? null); break;
      case "new-group": this.openGroupPrompt(p.machine ?? null, null, p.id); break;
      case "worktree": openOverlay({ mod: "worktree", kind: "dialog", ...(it.worktree === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: { space: p.id, action: it.worktree } }); break;
      case "close": run("space.close", { id: p.id }); break;
      case "new-space": queueNewSpaceInGroup(p.id, p.machine ?? null); break;
      case "fold": this.toggleGroup(p.id); break;
      case "rename-group": this.openGroupPrompt(p.machine ?? null, p.id); break;
      case "delete-group": this.deleteGroup(p.id); break;
      case "group-up": this.moveGroup(p.id, -1); break;
      case "group-down": this.moveGroup(p.id, 1); break;
    }
  }

  renderMenu() {
    const t = theme();
    const items = this.menuItems();
    if (!items.length) return v_flex().size_full().p(12).bg(t.popover).child(div().text_color(t.dim).child("This group is gone."));
    if (!items[this.at] || items[this.at].separator) this.at = Math.max(0, items.findIndex((it) => !it.separator));
    const leading = (it) => div().w(16).flex_none().flex().items_center().justify_center()
      .child(it.checked
        ? svg("mods/workspace-chrome/check.svg").size(12).text_color(t.accent)
        : it.icon ? svg(`mods/workspace-chrome/${it.icon}.svg`).size(13).text_color(it.danger ? t.blocked : t.muted) : div());
    const pointAt = (i, cx) => {
      if (this.at === i && this.menuPointer) return;
      this.menuPointer = true;
      this.at = i;
      cx.notify();
    };
    return v_flex()
      .id("kent-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down" || e.key === "up") this.menuPointer = false;
        if (e.key === "down") this.moveMenu(1);
        else if (e.key === "up") this.moveMenu(-1);
        else if (e.key === "enter") this.chooseMenu(this.at);
        else if (e.key === "escape") closeOverlay((this.menuProps ?? {}).overlay);
        else return;
        cx.notify();
      })
      .children(items.map((it, i) => it.separator
        ? div().mx(7).my(4).h(1).bg(t.border)
        : h_flex()
          .id(`kent-mi-${i}`)
          .h(29)
          .px(8)
          .gap(8)
          .rounded(7)
          .items_center()
          .text_color(it.danger ? t.blocked : t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .when(i !== this.at && this.menuPointer, (el) => el.hover((s) => s.bg(t.hover)))
          .on_hover((hovered, cx) => { if (hovered) pointAt(i, cx); })
          .on_mouse_move((_e, cx) => pointAt(i, cx))
          .on_click(() => this.chooseMenu(i))
          .child(leading(it))
          .child(div().flex_1().min_w(0).truncate().child(it.label))));
  }

  renderPrompt() {
    const t = theme();
    const p = this.prompt ?? {};
    const editing = Boolean(p.group);
    const empty = !(this.input?.value() ?? "").trim();
    const problem = this.promptProblem();
    const disabled = empty || Boolean(problem);
    const button = (id, text, primary, action, enabled = true) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .when(!enabled, (el) => el.opacity(0.45))
      .child(text);
    return v_flex()
      .id("kent-group-prompt")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          closeOverlay(p.overlay);
          cx.stop_propagation();
        }
      })
      .w_full()
      .min_h(0)
      .p(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(editing ? "Rename group" : "New group"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(14).pb(7).text_size(11.5).text_color(t.dim).child("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .when(Boolean(problem), (el) => el.child(div().pt(6).text_size(11.5).text_color(t.dim).child(problem)))
      .child(h_flex().pt(18).gap(8).justify_end()
        .child(button("kent-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("kent-save", editing ? "Rename" : "Create", true, () => this.submitPrompt(), !disabled)));
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  // The name comes first. The tail is laid out from what the name leaves, not from its
  // own text's width (which had the two give way in proportion, and a long branch cut
  // the name); when that is nearly nothing the \u2191\u2193 stay and the text goes. The text
  // is not even started when only a few letters of it would fit: "br\u2026" says nothing.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const fullName = name.toLowerCase();
    const emoji = EMOJI.exec(name)?.[0];
    const label = emoji ? name.slice(emoji.length).trim().toLowerCase() : fullName;
    const same = (a) => {
      const text = a.toLowerCase();
      return text === fullName || text === label;
    };
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    // An estimate, in the sidebar's pixels: what the row takes up around the two (83), a
    // tree row's indent and branch (43), the name (a 13px glyph, 7.8 Latin or 13 CJK)
    // and the gap after it. Less than TAIL_MIN left, and the text is left out.
    const room = (this.sidePx ?? 268) - 83 - (tree ? 43 : 0) - textPx(name) - 8;
    const where = room < TAIL_MIN ? "" : [repo, branch].filter(Boolean).join(" \u00b7 ");
    const marks = [g.ahead > 0 ? `\u2191${g.ahead}` : "", g.behind > 0 ? `\u2193${g.behind}` : ""].filter(Boolean);
    return h_flex()
      .flex_1()
      .min_w(marks.reduce((sum, mark) => sum + mark.length * 7 + 1, 0) + (marks.length > 1 ? 5 : 0))
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree, group = null }, t, sp, tabPanes) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : sp.findIndex(s => s.id === this.pressed);
    const fromPosition = this.positionOf[this.pressed] ?? fromIndex;
    const targetPosition = this.positionOf[w.id] ?? i;
    const targetGroup = group ?? null;
    const pane = programFor(w, tabPanes);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .border_1()
      .border_color("#00000000")
      .when(on, (el) => el.bg(t.selected).child(div().absolute().left(3).top(6).bottom(6).w(2).rounded(1).bg(t.accent)))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      // Worktrees are joined by a quiet line instead of a glyph, so a row still
      // reads as a row and the checkouts read as one family under their repo.
      .when(tree === "├─", (el) => el.child(div().absolute().left(15).top(0).bottom(0).w(1).bg(t.input)))
      .when(tree === "└─", (el) => el.child(div().absolute().left(15).top(0).h(13).w(1).bg(t.input)))
      .when(Boolean(tree), (el) => el.child(div().absolute().left(15).top(12).w(9).h(1).bg(t.input)))
      .when(this.filterActive() && this.filterPickId === w.id, (el) => el.bg(t.selected).border_color(t.accent))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromPosition < targetPosition, line => line.bottom(0))
          .when(fromPosition > targetPosition, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
        this.overGroup = targetGroup;
        this.overGroupMachine = w.machine ?? null;
        this.overUngroup = false;
      })
      .on_mouse_move((e, cx) => {
        if (this.pressed === null) return;
        if (e.pressed_button !== "left") {
          this.clearDrag();
          cx.notify();
          return;
        }
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        const nextGroup = over ? targetGroup : null;
        if (over !== null) this.ringReset();
        const nextMachine = over ? (w.machine ?? null) : null;
        if (this.over !== over || this.overGroup !== nextGroup || this.overGroupMachine !== nextMachine || this.overUngroup) {
          this.over = over;
          this.overGroup = nextGroup;
          this.overGroupMachine = nextMachine;
          this.overUngroup = false;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed === null) return;
        const from = this.pressed;
        const over = this.over;
        const click = from === w.id;
        this.clearDrag();
        if (click) run("space.select", { id: w.id });
        else if (over === w.id) this.dropOn(from, w.id);
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(programIcon(pane?.program, t)))
          // The name keeps its width while it fits: the tail is what narrows (see gitTail).
          // Cut only when it can't: at the end, or in the middle for a long one (LONG_NAME).
          .child(div().flex_initial().min_w(SIDE_MIN).truncate()
            .when(w.name.length > LONG_NAME, (el) => el.text_ellipsis_middle())
            .text_color(on ? t.foreground : t.muted).tooltip(nameTip(w)).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(w.status === "blocked" || w.status === "done", el => el.child(div().size(7).rounded(4).flex_none().bg(t[w.status]))),
      );
  }

  // A rail cell: the row's number (its place among the visible rows) and its state.
  compact({ w }, t, n) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .tooltip(nameTip(w))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(n + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    if (this.menuProps) return this.renderMenu();
    if (this.prompt) return this.renderPrompt();
    const t = theme();
    const collapsed = narrow();
    this.sidePx = find(layout(), "sidebar")?.size?.px ?? 268;
    const sp = spaces();
    const ps = panes();
    const ms = machines();
    const store = readStore();
    const update = shared("kent.update");
    const showUpdate = update?.status === "available" && update.version !== shared("kent.dismissed-version");
    const tabPanes = panesByTab(ps);
    const waiting = agents().filter((a) => a.status === "blocked");
    this.needsYou = waiting.length;
    this.firstBlockedSpace = waiting[0]?.space ?? null;
    const flat = this.grouped(t, collapsed, sp, ps, ms, store, tabPanes);
    this.filterPickId = this.filterActive() ? this.seen[this.filterAt] ?? null : null;
    const list = flat.map(([el]) => el);
    this.listItems = flat.map(([, m]) => m);
    if (this.pressed !== null && !collapsed) {
      const drop = this.ungroupDrop(t, sp, store);
      if (drop) {
        list.push(drop);
        this.listItems.push({ drop: true, machine: sp.find((s) => s.id === this.pressed)?.machine ?? null, h: 38 });
      }
    }
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.handleFilterKey(event, cx))
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed === null) return;
        // Not over a row's or a header's own handler, or the list scrolled under a still
        // pointer as it was let go (edgeFollow): go by what lies under the pointer.
        const from = this.pressed;
        const under = this.under();
        this.clearDrag();
        this.dropOnItem(from, under);
        cx.notify();
      })
      .on_window_mouse_move((e, cx) => {
        if (this.pressed === null || e.pressed_button === "left") return;
        this.clearDrag();
        cx.notify();
      })
      .on_window_mouse_up("left", (e, cx) => {
        if (this.pressed === null) return;
        const p = e.local_position, b = e.bounds;
        if (!p || !b || p.x < 0 || p.y < 0 || p.x > b.width || p.y > b.height) {
          this.clearDrag();
          cx.notify();
        }
      })
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).font_medium().text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_none().child("Spaces"))
          .when(this.needsYou > 0, (title) => title.child(div()
            .id("kent-needs")
            .flex_none()
            .h(16)
            .px(5)
            .rounded(8)
            .bg(t.blocked + "22")
            .text_size(10)
            .font_bold()
            .text_color(t.blocked)
            .flex()
            .items_center()
            .gap(1)
            .cursor_pointer()
            .tooltip(`${this.needsYou} agent${this.needsYou === 1 ? "" : "s"} waiting on you`)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              if (this.firstBlockedSpace) run("space.select", { id: this.firstBlockedSpace });
            })
            .child("!").child(String(this.needsYou))))
          .when(this.caption != null, (title) => title.child(this.machineTag(t)))))
        .child(h_flex().gap(2).items_center()
          .when(!collapsed && showUpdate, (el) => el.child(div().id("kent-update").h(26).px(7).flex_none().flex().items_center().rounded(6)
            .bg(t.accent).text_color(t.foreground).text_size(10.5).font_semibold().cursor_pointer().hover((s) => s.opacity(0.88))
            .tooltip(`Kent ${update.version} is out${update.notes ? ` · ${update.notes}` : ""}. Click to update.`)
            .on_click(() => run("mod.open", { name: "kent-updater" }))
            .child(`↑ ${update.version}`)))
          .when(!collapsed, el => el.child(div().id("space-filter").size(26).flex_none().flex().items_center().justify_center().rounded(6)
            .when(this.filtering, (b) => b.bg(t.selected).text_color(t.foreground))
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip(this.filtering ? "Close filter" : "Filter spaces")
            .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFilter(cx); })
            .child(svg("mods/workspace-chrome/search.svg").size(13))))
          .when(!collapsed, el => el.child(div().id("group-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("New group")
            .on_click(() => this.openGroupPrompt(sp.find((space) => space.active)?.machine ?? null)).child(svg("mods/workspace-chrome/folder-plus.svg").size(13))))
          .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("New space")
            .on_click((_e, cx) => { cx.stop_propagation(); this.newSpaceHere(cx); }).child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .when(!collapsed && this.filtering, (el) => el.child(h_flex()
        .id("kent-filter")
        .h(30)
        .mx(8)
        .mb(5)
        .px(8)
        .gap(6)
        .items_center()
        .rounded(7)
        .border_1()
        .border_color(this.filterFocused ? t.accent : t.input)
        .bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(12).flex_none().text_color(t.dim))
        .child(Input.new(this.filterInput).flex_1().h(26).text_size(12).text_color(t.foreground))
        .child(div().flex_none().text_size(9.5).text_color(t.dim).child("Esc"))))
      .when(Boolean(this.notice) && Date.now() < (this.notice?.until ?? 0), (el) => el.child(div()
        .mx(8)
        .mb(4)
        .px(8)
        .py(5)
        .rounded(6)
        .bg(t.blocked + "18")
        .text_size(11)
        .text_color(t.blocked)
        .child(this.notice.text)))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("hover").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        // Only a height change counts: a hover scrollbar also reports a width change, and revealing the active row on that
        // would pull a wheel-scrolled list back (scroll_to_item scrolls only when the row is out of view).
        .on_size_change((size, cx) => {
          const height = Math.round(size.height);
          if (this.listHeight !== height) {
            this.listHeight = height;
            if (Date.now() - this.wheelAt > 1000 && this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); }
          }
          this.soonCaption(cx);
        })
        .on_scroll_wheel((_e, cx) => { this.wheelAt = Date.now(); this.soonCaption(cx); })
        // A dragged row held near an edge scrolls the list: the pointer is followed wherever it is in the window.
        .on_window_mouse_move((e, cx) => this.edgeFollow(e, cx))
        .children(list));
  }
}
