// The update window. Opening it is cheap: the sidebar checks every six hours,
// this copy only re-checks when opened or asked. All writes live in updater.js.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, shared, setShared, closeOverlay, props, checking } from "herdr";
import { checkForUpdate, fetchRemoteManifest, installUpdate, readLocalManifest } from "./updater.js";

export default class KentUpdater extends View {
  init(_props, cx) {
    this.info = shared("kent.update") ?? null;
    this.remote = null;
    this.localVersion = "…";
    this.lastLog = "";
    this.progress = null;
    this.busy = false;
    this.checkingNow = false;
    this.updated = false;
    this.updatedFrom = null;
    this.backupDir = "";
    this.error = "";
    this.errorSource = null; // "check" | "install": a failed install is not a network hiccup
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (checking()) return;
    readLocalManifest().then((local) => {
      this.localVersion = local.manifest?.version ?? "0.0.0";
      this.notify(cx);
    }).catch(() => {});
    this.checkNow(cx);
  }

  notify(cx) {
    try {
      cx.notify();
    } catch {
      // The window was replaced or closed while a download was running.
    }
  }

  requestTimeout(cx) {
    return (ms) => new Promise((resolve) => {
      cx.timer.after(ms, resolve);
    });
  }

  log(cx, line, progress = null) {
    this.lastLog = String(line);
    if (progress) this.progress = { ...progress, label: this.lastLog };
    this.notify(cx);
  }

  checkNow(cx) {
    if (this.busy || this.checkingNow) return;
    this.checkingNow = true;
    this.updated = false;
    this.error = "";
    this.errorSource = null;
    this.progress = null;
    this.lastLog = "Checking GitHub...";
    this.notify(cx);
    cx.spawn(async (cx) => {
      try {
        const result = await checkForUpdate(this.requestTimeout(cx));
        this.info = result.info;
        this.remote = result.remote;
        this.localVersion = result.info.currentVersion ?? this.localVersion;
      } catch (error) {
        this.error = String(error?.message ?? error);
        this.errorSource = "check";
      } finally {
        this.checkingNow = false;
        this.notify(cx);
      }
    });
  }

  startInstall(cx) {
    if (this.busy || this.checkingNow || this.info?.status !== "available") return;
    this.busy = true;
    this.updated = false;
    this.updatedFrom = this.localVersion === "…" ? null : this.localVersion;
    this.backupDir = "";
    this.error = "";
    this.errorSource = null;
    this.lastLog = `Preparing Kent ${this.info.version}...`;
    this.progress = { phase: "prepare", current: 0, total: 1, label: this.lastLog };
    this.notify(cx);
    cx.spawn(async (cx) => {
      try {
        const remote = this.remote && this.remote.manifest?.version === this.info.version
          ? this.remote
          : await fetchRemoteManifest(this.requestTimeout(cx));
        const result = await installUpdate(remote, (line, progress) => this.log(cx, line, progress), this.requestTimeout(cx));
        this.info = {
          status: "current",
          version: result.version,
          currentVersion: result.version,
          notes: this.info?.notes ?? "",
          checkedAt: Date.now(),
        };
        this.localVersion = result.version;
        this.updated = true;
        this.backupDir = result.backupDir ?? "";
        this.progress = { phase: "done", current: 1, total: 1, label: `Kent ${result.version} installed.` };
        this.lastLog = `Kent ${result.version} installed.`;
        this.notify(cx);
        const overlay = props()?.overlay;
        if (overlay) {
          cx.timer.after(4000, () => {
            try {
              closeOverlay(overlay);
            } catch {
              // The window was already closed.
            }
          });
        }
      } catch (error) {
        this.error = String(error?.message ?? error);
        this.errorSource = "install";
        this.progress = null;
        this.updated = false;
      } finally {
        this.busy = false;
        this.notify(cx);
      }
    });
  }

  close() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  // "Later" really means later: the chip stays in the sidebar as the reminder.
  later() {
    this.close();
  }

  // "Skip" is the strong one: this version is never offered again.
  skip() {
    if (this.info?.version) setShared("kent.dismissed-version", this.info.version);
    this.close();
  }

  onKey(event, cx) {
    const key = String(event.key ?? "").toLowerCase();
    if (key === "escape" && !this.busy) {
      this.close();
      cx.stop_propagation();
      return true;
    }
    if (key === "enter" && this.info?.status === "available" && !this.busy && !this.checkingNow && !this.updated) {
      this.startInstall(cx);
      cx.stop_propagation();
      return true;
    }
    return false;
  }

  progressState() {
    if (this.updated) return { pct: 100, label: "Done", detail: this.lastLog };
    if (this.checkingNow) {
      return { indeterminate: true, label: "Checking", detail: this.lastLog || "Checking GitHub..." };
    }
    if (!this.busy) return null;
    const p = this.progress ?? {};
    const current = Number(p.current) || 0;
    const total = Number(p.total) || 0;
    const ratio = total ? Math.min(1, current / total) : 0;
    let pct = 2;
    let label = "Preparing";
    if (p.phase === "download") {
      // current/total are bytes (weighted so big files don't look stuck);
      // file/files are the count, for the label.
      pct = 5 + ratio * 60;
      label = p.files ? `Downloading ${Math.min(p.file ?? 0, p.files)} of ${p.files}` : "Downloading";
    } else if (p.phase === "verify") {
      pct = 70;
      label = "Verifying files";
    } else if (p.phase === "stage") {
      pct = 75 + ratio * 13;
      label = "Checking staged mods";
    } else if (p.phase === "write") {
      pct = 92 + ratio * 5;
      label = "Installing";
    } else if (p.phase === "done") {
      pct = 100;
      label = "Done";
    }
    return { pct, label, detail: p.detail || p.label || this.lastLog };
  }

  lastCheckedLabel(info) {
    const checkedAt = Number(info?.checkedAt);
    if (!checkedAt) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - checkedAt) / 1000));
    if (seconds < 60) return "Checked just now";
    if (seconds < 3600) return `Checked ${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `Checked ${Math.floor(seconds / 3600)} h ago`;
    return "";
  }

  render(cx) {
    const t = theme();
    const info = this.info ?? {};
    const available = info.status === "available";
    const unsupported = info.status === "unsupported";
    const current = info.status === "current";
    const failedCheck = info.status === "error" && !this.error;
    const error = this.error || (info.status === "error" ? info.error : "");
    const errorSource = this.error ? (this.errorSource ?? "check") : failedCheck ? "check" : null;
    const version = info.version ?? this.localVersion;
    const installed = this.localVersion === "…" ? "" : this.localVersion;
    const destructive = t.destructive ?? t.blocked ?? "#f38ba8";
    const done = t.done ?? t.accent;

    const button = (id, text, primary, enabled, action, tip = "") => {
      const el = h_flex()
        .id(id).h(31).px(13).items_center().rounded(7).border_1()
        .border_color(primary ? t.solid : t.input)
        .bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground)
        .text_size(11.5).font_medium()
        .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
        .when(!enabled, (el) => el.opacity(0.45))
        .child(text);
      return tip ? el.tooltip(tip) : el;
    };

    const progress = this.progressState();
    const headline = this.updated
      ? "Updated successfully"
      : this.busy
        ? "Updating Kent"
        : this.checkingNow
          ? "Checking for updates"
          : error
            ? errorSource === "install"
              ? "Update failed"
              : "Update check failed"
            : available
              ? "An update is available"
              : current
                ? "You're up to date"
                : unsupported
                  ? "Herdr update required"
                  : "Update check failed";
    const subtitle = this.updated
      ? `Kent ${version} is installed. Herdr reloads the layout in place; this window closes itself.`
      : this.busy
        ? "Downloading and installing the latest layout. Keep Herdr open."
        : this.checkingNow
          ? "Looking for the latest release on GitHub."
          : error
            ? errorSource === "install"
              ? "Your installed version is unchanged."
              : "GitHub could not be reached. Check again in a moment."
            : available
              ? "A newer layout is ready to install."
              : current
                ? "The latest layout is installed and active."
                : unsupported
                  ? `This release needs Herdr ${info.minHerdr || "newer"} or newer (this is ${info.appVersion || "unknown"}).`
                  : "GitHub could not be reached. Check again in a moment.";

    // The header icon mirrors the state: a spinner while work is in flight, a
    // check on success, a bang on failure, the plain arrow otherwise.
    const iconTone = this.updated ? done : error ? destructive : t.accent;
    const icon = this.updated
      ? div().text_size(17).font_bold().text_color(iconTone).child("✓")
      : this.busy || this.checkingNow
        ? svg("mods/workspace-chrome/spinner.svg").size(16).text_color(iconTone).spin(900)
        : error
          ? div().text_size(17).font_bold().text_color(iconTone).child("!")
          : div().text_size(18).font_bold().text_color(iconTone).child("↑");
    const header = h_flex().items_center().gap(10)
      .child(div().size(38).flex_none().rounded(10)
        .bg(iconTone + "18").border_1().border_color(iconTone + "33")
        .flex().items_center().justify_center()
        .child(icon))
      .child(v_flex().gap(1)
        .child(div().text_size(15).font_semibold().child("Software Update"))
        .child(div().text_size(10.5).text_color(t.dim).child("Kent layout for Herdr")))
      .child(h_flex().flex_1());

    const heroTitle = h_flex().items_center().gap(8)
      .child(div().text_size(21).font_bold().child(headline));

    // The version story in one place: where you are, where you are going.
    const from = this.updated ? this.updatedFrom : installed;
    const showJump = Boolean(from) && from !== version && (available || unsupported || this.busy || this.updated);
    const chip = (text, fg, bg, border) => h_flex().h(20).px(7).flex_none().items_center().rounded(5)
      .bg(bg).border_1().border_color(border)
      .text_size(10.5).font_semibold().text_color(fg).child(text);
    let versionRow = null;
    if (showJump) {
      const toTone = this.updated ? done : t.accent;
      versionRow = h_flex().items_center().gap(6)
        .child(chip(from, t.dim, t.raised, t.input))
        .child(div().text_size(11).text_color(t.dim).child("→"))
        .child(chip(version, toTone, toTone + "14", toTone + "33"));
    } else if (current && version && version !== "…") {
      versionRow = h_flex().items_center().gap(6)
        .child(chip(version, t.muted, t.raised, t.input));
    }

    const hero = v_flex().pt(16).gap(4)
      .child(heroTitle)
      .when(Boolean(versionRow), (el) => el.child(versionRow))
      .child(div().text_size(11.5).text_color(t.dim).max_w(500).child(subtitle))
      .when(this.updated && Boolean(this.backupDir), (el) => el.child(
        div().text_size(10).text_color(t.dim).max_w(500).truncate()
          .tooltip(String(this.backupDir))
          .child(`Backup of the previous install: ${String(this.backupDir).split("/").pop()}`),
      ));

    let progressBlock = null;
    if (progress) {
      const fill = progress.indeterminate
        ? div().id("kent-update-fill").h(5).w_full().rounded(3).bg(t.accent)
          .loop("opacity", { from: 0.2, to: 0.65, period: 1100 })
        : div().id("kent-update-fill").h(5).w(`${Math.max(0, Math.min(100, Math.round(progress.pct)))}%`).rounded(3).bg(t.accent)
          .transition("width", 220);
      const track = div().h(5).w_full().rounded(3).bg(t.input).overflow_hidden().child(fill);
      const row = h_flex().items_center().justify_between().gap(10)
        .child(div().text_size(10.5).text_color(t.dim).max_w(390).truncate()
          .tooltip(progress.detail ?? "").child(progress.detail ?? ""))
        .child(div().text_size(10).text_color(t.dim).flex_none().child(progress.label));
      progressBlock = v_flex().pt(14).gap(6).child(track).child(row);
    }

    let errorBlock = null;
    if (error) {
      const card = v_flex().p(12).gap(4).rounded(8)
        .bg(destructive + "12").border_1().border_color(destructive + "33")
        .child(div().text_size(9.5).font_semibold().text_color(destructive)
          .child(errorSource === "install" ? "INSTALL FAILED" : "UPDATE ERROR"))
        .child(div().text_size(11.5).text_color(destructive).max_h(110).overflow_y_scrollbar().mode("hover")
          .tooltip(error).child(error));
      errorBlock = v_flex().pt(14).child(card);
    }

    // Notes are a decision-time read. While the install runs — and in the
    // brief success state — the progress row takes their place: showing both
    // would overflow the window's fixed height when the notes are long.
    let notesBlock = null;
    if (!error && !this.busy && !this.updated && info.notes && (available || current || unsupported)) {
      const card = v_flex().p(12).gap(4).rounded(8).bg(t.raised).border_1().border_color(t.input)
        .child(div().text_size(9.5).font_semibold().text_color(t.dim).child(`WHAT'S NEW IN ${version}`))
        .child(div().text_size(11.5).text_color(t.muted).max_h(128).overflow_y_scrollbar().mode("hover")
          .child(String(info.notes)));
      notesBlock = v_flex().pt(14).child(card);
    }

    const checkAgain = this.busy || this.updated
      ? null
      : div().id("kent-update-check").text_size(10).cursor_pointer()
        .text_color(this.checkingNow ? t.dim : t.accent)
        .when(!this.checkingNow, (el) => el.hover((s) => s.opacity(0.75)).on_click(() => this.checkNow(cx)))
        .tooltip("Check GitHub again now")
        .child(this.checkingNow ? "Checking..." : "Check again");

    const retry = errorSource === "install" && available;
    const trio = available && !this.busy && !this.checkingNow && !this.updated;
    const actions = h_flex().items_center().gap(8).justify_end()
      .when(trio, (el) => el.child(button(
        "kent-update-skip", "Skip", false, true, () => this.skip(),
        `Hide Kent ${version}; the next release is still offered`,
      )))
      .when(trio, (el) => el.child(button(
        "kent-update-later", "Later", false, true, () => this.later(),
        "Close for now; the update chip stays in the sidebar",
      )))
      .when(!trio && !this.busy && !this.updated, (el) => el.child(button(
        "kent-update-close", "Close", false, true,
        () => this.close(),
      )))
      .when(trio, (el) => el.child(button(
        "kent-update-install", retry ? "Retry update" : "Update now", true, true, () => this.startInstall(cx),
      )))
      .when(this.busy, (el) => el.child(button(
        "kent-update-install", "Updating...", true, false, () => {},
      )))
      .when(this.updated, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("Closing...")));

    const footer = h_flex().items_center().gap(10)
      .child(div().text_size(10).text_color(t.dim).child(this.lastCheckedLabel(info)))
      .when(Boolean(checkAgain), (el) => el.child(checkAgain))
      .child(h_flex().flex_1())
      .child(actions);

    return v_flex()
      .id("kent-updater")
      .size_full()
      .min_h(0)
      .p(20)
      .bg(t.popover)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(header)
      .child(hero)
      .when(Boolean(progressBlock), (el) => el.child(progressBlock))
      .when(Boolean(errorBlock), (el) => el.child(errorBlock))
      .when(Boolean(notesBlock), (el) => el.child(notesBlock))
      .child(h_flex().flex_1())
      .child(footer);
  }
}
