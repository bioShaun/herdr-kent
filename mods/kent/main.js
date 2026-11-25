// Kent spaces: program-icon rows in named, foldable groups inside each machine.
// Worktrees stay under their checkout and the git tail follows Herdr's spaces list.
// Click to switch, right-click to assign a group, drag onto a group or another row.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout, nextCommand, checking } from "herdr";
import { iconChip } from "./icon-chip.js";

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
// A space's name and its git tail never shrink below this, so a short one ("api")
// stays readable instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
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
const DEFAULT_GROUP = "__default__";
const groupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const pendingGroupSpaces = [];
let wakeGroupSpaces = null;
// The mod's load time stands in for the app's start: a machine that answers
// with no spaces at all within this grace window may simply still be loading,
// so its group membership is not pruned yet.
const startedAt = Date.now();
const STARTUP_GRACE = 10000;
const PRUNE_EVERY = 60000;

// Closed spaces leave their ids behind in group membership. Prune them, but
// only for a machine that is definitely answering: one that is away, asleep or
// still loading keeps every id, because its spaces simply aren't here to ask.
// Returns true when at least one dead id was removed.
function pruneStore(data, sp, ms, busyMachines) {
  if (checking()) return false;
  let removed = false;
  const machineNames = new Set(data.groups.map((g) => g.machine ?? null));
  for (const machine of machineNames) {
    const entry = ms.find((m) => (m.name ?? null) === machine);
    if (!entry || entry.layout !== "ready") continue;
    if (busyMachines.has(machine)) continue;
    const live = new Set(sp.filter((s) => (s.machine ?? null) === machine).map((s) => s.id));
    if (!live.size && Date.now() - startedAt < STARTUP_GRACE) continue;
    for (const g of data.groups) {
      if ((g.machine ?? null) !== machine) continue;
      const list = data.in[g.id];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((id) => live.has(id));
      if (kept.length !== list.length) {
        data.in[g.id] = kept;
        removed = true;
      }
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

// Groups are per machine. A space id is in at most one group's ordered list;
// absence from every list means the space is ungrouped.
function readStore() {
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

function writeStore(data) {
  setShared(STORE, { version: 1, groups: data.groups, in: data.in, defaultFolded: data.defaultFolded ?? {}, at: Date.now() });
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
    this.overUngroup = false;
    this.positionOf = {};
    this.seen = [];
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    if (!checking()) {
      this.refreshMachines(cx);
      cx.timer.every(15000, cx => this.refreshMachines(cx));
      // Refresh only when the refs could have changed (see `due`).
      cx.timer.every(250, (cx) => this.checkNew(cx));
      cx.spawn(async (cx) => {
        for (;;) {
          const c = String(await nextCommand()).split(".").pop();
          if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1);
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

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    // Dead ids are pruned here at most once a minute, and inline with every
    // membership write; writeStore only happens when something was removed.
    if (now - (this.prunedAt ?? 0) > PRUNE_EVERY) {
      this.prunedAt = now;
      const data = readStore();
      if (this.pruneStoreData(data)) writeStore(data);
    }
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
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
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
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
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
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
    this.overUngroup = false;
  }

  groupsFor(machine, data = readStore()) {
    return data.groups.filter((g) => (g.machine ?? null) === (machine ?? null));
  }

  // Prune dead space ids from a freshly read store. Machines with a space
  // creation still in flight are skipped: their membership is about to change.
  pruneStoreData(data) {
    const busy = new Set((this.newSpaceRequests ?? []).map((r) => r.machine ?? null));
    return pruneStore(data, spaces(), machines(), busy);
  }

  groupOf(spaceId, machine, data = readStore()) {
    for (const g of data.groups) {
      if ((g.machine ?? null) !== (machine ?? null)) continue;
      if ((data.in[g.id] ?? []).includes(spaceId)) return g.id;
    }
    return null;
  }

  createGroup(name, machine, spaceId = null) {
    const data = readStore();
    const id = groupId();
    data.groups.push({ id, name, machine: machine ?? null, folded: false });
    data.in[id] = [];
    if (spaceId) {
      removeFromGroups(data, spaceId);
      data.in[id].push(spaceId);
    }
    this.pruneStoreData(data);
    writeStore(data);
  }

  renameGroup(id, name) {
    const data = readStore();
    const group = data.groups.find((g) => g.id === id);
    if (!group) return;
    group.name = name;
    writeStore(data);
  }

  deleteGroup(id) {
    const data = readStore();
    const at = data.groups.findIndex((g) => g.id === id);
    if (at === -1) return;
    data.groups.splice(at, 1);
    delete data.in[id];
    this.pruneStoreData(data);
    writeStore(data);
  }

  toggleGroup(id, machine = null) {
    const data = readStore();
    if (id === DEFAULT_GROUP) {
      const key = machine ?? "";
      if (data.defaultFolded[key]) delete data.defaultFolded[key];
      else data.defaultFolded[key] = true;
      writeStore(data);
      return;
    }
    const group = data.groups.find((g) => g.id === id);
    if (!group) return;
    group.folded = !group.folded;
    writeStore(data);
  }

  moveGroup(id, dir) {
    const data = readStore();
    const at = data.groups.findIndex((g) => g.id === id);
    if (at === -1) return;
    const machine = data.groups[at].machine ?? null;
    const positions = data.groups.map((g, i) => ((g.machine ?? null) === machine ? i : -1)).filter((i) => i !== -1);
    const own = positions.indexOf(at);
    const swap = positions[own + dir];
    if (swap === undefined) return;
    [data.groups[at], data.groups[swap]] = [data.groups[swap], data.groups[at]];
    writeStore(data);
  }

  assignToGroup(spaceId, targetGroup, targetId = null, after = true) {
    const data = readStore();
    if (targetGroup && !data.groups.some((g) => g.id === targetGroup)) return;
    removeFromGroups(data, spaceId);
    if (targetGroup) {
      const list = data.in[targetGroup] ??= [];
      const at = targetId ? list.indexOf(targetId) : -1;
      if (at === -1) list.push(spaceId);
      else list.splice(at + (after ? 1 : 0), 0, spaceId);
    }
    this.pruneStoreData(data);
    writeStore(data);
  }

  setGroupFolded(id, machine, folded) {
    const data = readStore();
    if (id === DEFAULT_GROUP) {
      const key = machine ?? "";
      if (folded) data.defaultFolded[key] = true;
      else delete data.defaultFolded[key];
      writeStore(data);
      return;
    }
    const group = data.groups.find((g) => g.id === id);
    if (!group) return;
    group.folded = folded;
    writeStore(data);
  }

  createdSpace(before, machine) {
    const created = spaces().filter((space) => !before.has(space.id) && (space.machine ?? null) === (machine ?? null));
    return created.find((space) => space.active) ?? created.at(-1) ?? null;
  }

  async createSpaceInGroup(request, cx) {
    const before = new Set(spaces().map((space) => space.id));
    run("space.new", { machine: request.machine ?? "", focus: true });
    let created = this.createdSpace(before, request.machine);
    // The document usually changes after the initiating event returns, not inside it.
    // Wait on GPUI's foreground executor; setTimeout is not available to mods.
    for (let attempt = 0; !created && attempt < 50; attempt += 1) {
      await cx.sleep(100);
      created = this.createdSpace(before, request.machine);
    }
    if (!created) return;
    this.assignToGroup(created.id, request.group);
    if (request.unfold) this.setGroupFolded(request.group, request.machine, false);
    cx.notify();
  }

  // Space creation does not return the new id. Serialize requests so a quick
  // second click cannot make two pending creations race for the same diff.
  newSpaceInGroup(g, machine = g.machine ?? null, cx = null) {
    if (g.virtual) {
      run("space.new", { machine: machine ?? "", focus: true });
      if (g.folded) this.setGroupFolded(g.id, machine, false);
      return;
    }
    const request = { group: g.id, machine: machine ?? null, unfold: Boolean(g.folded) };
    if (!cx) {
      const before = new Set(spaces().map((space) => space.id));
      run("space.new", { machine: request.machine ?? "", focus: true });
      const created = this.createdSpace(before, request.machine);
      if (created) this.assignToGroup(created.id, request.group);
      if (created && request.unfold) this.setGroupFolded(request.group, request.machine, false);
      return;
    }
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
      && this.ordering.machines.every(name => ms.some(m => m.name === name && m.layout === "ready"));
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

  machineRows(machine, mine, draw, t, collapsed, data) {
    const positions = new Map();
    const visible = [];
    if (collapsed) {
      mine.forEach((r, i) => {
        positions.set(r.w.id, i);
        this.positionOf[r.w.id] = i;
        visible.push(r.w.id);
      });
      return { items: mine.map((r) => draw({ ...r, group: null })), positions, visible };
    }
    const rowById = new Map(mine.map((r) => [r.w.id, r]));
    const groups = data.groups.filter((g) => (g.machine ?? null) === (machine ?? null));
    const claimed = new Map();
    for (const g of groups) {
      for (const id of data.in[g.id] ?? []) {
        if (rowById.has(id) && !claimed.has(id)) claimed.set(id, g.id);
      }
    }
    const entries = [];
    let at = 0;
    for (const g of groups) {
      const ids = (data.in[g.id] ?? []).filter((id) => rowById.has(id) && claimed.get(id) === g.id);
      const members = this.groupTrees(ids.map((id) => rowById.get(id)));
      entries.push({ kind: "head", g, members });
      at += 1;
      if (g.folded) continue;
      for (const r of members) {
        positions.set(r.w.id, at);
        this.positionOf[r.w.id] = at;
        visible.push(r.w.id);
        entries.push({ kind: "row", r, group: g.id });
        at += 1;
      }
    }
    const loose = mine.filter((row) => !claimed.has(row.w.id));
    if (loose.length) {
      const fallback = defaultGroupFor(machine, data);
      if (groups.length > 0 || fallback.folded) {
        entries.push({ kind: "head", g: fallback, members: loose });
        at += 1;
      }
      if (!fallback.folded) {
        for (const r of loose) {
          positions.set(r.w.id, at);
          this.positionOf[r.w.id] = at;
          visible.push(r.w.id);
          entries.push({ kind: "row", r, group: null });
          at += 1;
        }
      }
    }
    const items = entries.map((entry) =>
      entry.kind === "head" ? this.groupHead(entry.g, entry.members, machine, t) : draw({ ...entry.r, group: entry.group }),
    );
    return { items, positions, visible };
  }

  groupHead(g, members, machine, t) {
    const statuses = members.map((r) => r.w.status);
    const status = statuses.includes("blocked") ? "blocked" : statuses.includes("done") ? "done" : null;
    const sameMachine = (this.overGroupMachine ?? null) === (machine ?? null);
    const highlighted = this.pressed !== null && this.overGroup === g.id && this.over === null && sameMachine;
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
      .when(g.folded && Boolean(status), (el) => el.child(div().size(7).rounded(4).flex_none().bg(t[status])))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(String(members.length)))
      .child(div().id(`kent-group-new-${machine ?? "local"}-${g.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`New space in ${g.name}`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.newSpaceInGroup(g, machine, cx); })
        .child(svg("mods/workspace-chrome/plus.svg").size(10)))
      .child(svg(`mods/workspace-chrome/chevron-${g.folded ? "right" : "down"}.svg`).size(10).flex_none().text_color(t.dim));
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

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed, sp, ps, ms, store, tabPanes) {
    const rows = this.ordered(sp, ps, ms, store);
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t, sp, tabPanes));
    this.seen = [];
    this.positionOf = {};
    // Where the active space's row lands among the children this returns: the list scrolls by its direct
    // children, and machine headers, login notes and loading rows count too.
    this.activeAt = -1;
    let before = 0;
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = ms.find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || sp.some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [loadingRow(null)];
      const packed = this.machineRows(null, rows, draw, t, collapsed, store);
      this.seen.push(...packed.visible);
      const active = rows.find((r) => r.w.active)?.w.id;
      this.activeAt = active ? packed.positions.get(active) ?? -1 : -1;
      return packed.items;
    }
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m, machineIndex) => {
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
              .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); })
              .child(svg("mods/workspace-chrome/plus.svg").size(11))))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before += 1; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const packed = folded ? null : this.machineRows(m, mine, draw, t, collapsed, store);
      const content = !packed ? [] : packed.items.length ? packed.items : [loading(m) ? loadingRow(m) : cell(empty)];
      const items = [cell(head), ...guidance, ...content];
      if (packed) {
        this.seen.push(...packed.visible);
        const active = mine.find((r) => r.w.active)?.w.id;
        const position = active ? packed.positions.get(active) : undefined;
        if (position !== undefined) this.activeAt = before + 1 + guidance.length + position;
      }
      before += items.length;
      return items;
    });
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
  // and master/main go: nearly every space is on one. When the row is full, it
  // and the name both start from their text's width and give way in proportion.
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
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_auto()
      .min_w(where ? SIDE_MIN : 0)
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
        const spNow = spaces();
        const source = spNow.find(s => s.id === from);
        const sourceGroup = source ? this.groupOf(from, source.machine ?? null) : null;
        const after = fromPosition < targetPosition;
        this.clearDrag();
        if (over === w.id && from !== w.id) {
          const fromIdx = spNow.findIndex(s => s.id === from);
          const targetIdx = spNow.findIndex(s => s.id === w.id);
          const moveInDefault = () => {
            if (fromIdx === -1 || targetIdx === -1) return;
            const adj = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
            const dest = adj + (after ? 2 : 1);
            if (dest !== fromIdx + 1) run("space.move", { id: from, index: dest });
          };
          if (targetGroup !== null || sourceGroup !== null) {
            this.assignToGroup(from, targetGroup, w.id, after);
            if (targetGroup === null) moveInDefault();
          } else moveInDefault();
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(programIcon(pane?.program, t)))
          .child(div().flex_initial().min_w(SIDE_MIN).truncate().text_color(on ? t.foreground : t.muted).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(w.status === "blocked" || w.status === "done", el => el.child(div().size(7).rounded(4).flex_none().bg(t[w.status]))),
      );
  }

  compact({ w, i }, t) {
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
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    if (this.menuProps) return this.renderMenu();
    if (this.prompt) return this.renderPrompt();
    const t = theme();
    const collapsed = narrow();
    const sp = spaces();
    const ps = panes();
    const ms = machines();
    const store = readStore();
    const tabPanes = panesByTab(ps);
    const list = this.grouped(t, collapsed, sp, ps, ms, store, tabPanes);
    if (this.pressed !== null && !collapsed) {
      const drop = this.ungroupDrop(t, sp, store);
      if (drop) list.push(drop);
    }
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed === null) return;
        this.clearDrag();
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
        .when(!collapsed, el => el.child("Spaces"))
        .child(h_flex().gap(2).items_center()
          .when(!collapsed, el => el.child(div().id("group-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("New group")
            .on_click(() => this.openGroupPrompt(sp.find((space) => space.active)?.machine ?? null)).child(svg("mods/workspace-chrome/folder-plus.svg").size(13))))
          .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("New space")
            .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        .children(list));
  }
}
