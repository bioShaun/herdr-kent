// The update window. Opening it is cheap: the sidebar checks every six hours,
// this copy only re-checks when opened or asked. All writes live in updater.js.

import { View, div } from "gpui-kit";
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
    this.error = "";
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
    this.progress = { phase: "check", current: 0, total: 1, label: "Checking GitHub..." };
    this.lastLog = "Checking GitHub...";
    this.notify(cx);
    cx.spawn(async (cx) => {
      try {
        const result = await checkForUpdate(this.requestTimeout(cx));
        this.info = result.info;
        this.remote = result.remote;
        this.localVersion = result.info.currentVersion ?? this.localVersion;
        this.progress = null;
      } catch (error) {
        this.error = String(error?.message ?? error);
        this.progress = null;
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
    this.error = "";
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
        this.progress = { phase: "done", current: 1, total: 1, label: `Kent ${result.version} installed.` };
        this.lastLog = `Kent ${result.version} installed.`;
        this.notify(cx);
        const overlay = props()?.overlay;
        if (overlay) {
          cx.timer.after(2000, () => {
            try {
              closeOverlay(overlay);
            } catch {
              // The window was already closed.
            }
          });
        }
      } catch (error) {
        this.error = String(error?.message ?? error);
        this.progress = null;
        this.updated = false;
      } finally {
        this.busy = false;
        this.notify(cx);
      }
    });
  }

  later() {
    if (this.info?.version) setShared("kent.dismissed-version", this.info.version);
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  progressState() {
    if (this.updated) return { pct: 100, label: "Done", detail: this.lastLog };
    if (this.checkingNow) {
      return { pct: 4, label: "Checking", detail: this.lastLog || "Checking GitHub..." };
    }
    if (!this.busy) return null;
    const p = this.progress ?? {};
    const current = Number(p.current) || 0;
    const total = Number(p.total) || 0;
    let pct = 8;
    let label = "Preparing";
    if (p.phase === "download") {
      pct = total ? 10 + Math.min(1, current / total) * 70 : 30;
      label = total ? `Downloading ${Math.min(current, total)} of ${total}` : "Downloading";
    } else if (p.phase === "verify") {
      pct = 84;
      label = "Verifying files";
    } else if (p.phase === "install") {
      pct = 92;
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
    const overlay = props()?.overlay;
    const info = this.info ?? {};
    const available = info.status === "available";
    const unsupported = info.status === "unsupported";
    const current = info.status === "current";
    const error = this.error || (info.status === "error" ? info.error : "");
    const version = info.version ?? this.localVersion;
    const installed = this.localVersion === "…" ? "" : this.localVersion;
    const destructive = t.destructive ?? t.blocked ?? "#f38ba8";
    const pill = (text, color) => h_flex().h(20).px(8).items_center().rounded(10)
      .bg(color + "18").border_1().border_color(color + "33")
      .text_size(10).font_semibold().text_color(color).child(text);
    const button = (id, text, primary, enabled, action) => h_flex()
      .id(id).h(31).px(13).items_center().rounded(7).border_1()
      .border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(11.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .when(!enabled, (el) => el.opacity(0.45))
      .child(text);

    const progress = this.progressState();
    const headline = this.updated
      ? "Updated successfully"
      : this.busy
        ? "Updating Kent"
        : this.checkingNow
          ? "Checking for updates"
          : available
            ? `Kent ${version}`
            : error
              ? "Update check failed"
              : current
                ? "You're up to date"
                : unsupported
                  ? "Herdr update required"
                  : "Update check failed";
    const subtitle = this.updated
      ? `Kent ${version} is installed. Herdr will reload the layout; this window closes itself.`
      : this.busy
        ? "Downloading and installing the latest layout. Keep Herdr open."
        : this.checkingNow
          ? "Looking for the latest release on GitHub."
          : available
            ? `A newer layout is ready to install${installed ? `; you have ${installed}` : ""}.`
            : error
              ? "GitHub could not be reached. Check again in a moment."
              : current
                ? `Kent ${version} is installed and active.`
                : unsupported
                  ? `This release needs Herdr ${info.minHerdr || "newer"} or newer (this is ${info.appVersion || "unknown"}).`
                  : "GitHub could not be reached. Check again in a moment.";
    const statusPill = this.updated
      ? pill("Up to date", t.accent)
      : this.busy
        ? pill(progress?.label ?? "Updating", t.accent)
        : this.checkingNow
          ? pill("Checking", t.dim)
          : available
            ? pill("Update available", t.accent)
            : unsupported
              ? pill("Unsupported", t.blocked ?? destructive)
              : error
                ? pill("Error", destructive)
                : current
                  ? pill("Current", t.dim)
                  : null;

    const installedBadge = installed
      ? h_flex().h(22).px(8).items_center().rounded(6).bg(t.raised).border_1()
        .border_color(t.input).text_size(10).text_color(t.dim).child(`installed ${installed}`)
      : null;
    const header = h_flex().items_center().gap(10)
      .child(div().size(38).flex_none().rounded(10)
        .bg(t.accent + "18").border_1().border_color(t.accent + "33")
        .flex().items_center().justify_center()
        .child(div().text_size(18).font_bold().text_color(t.accent).child("↑")))
      .child(v_flex().gap(1)
        .child(div().text_size(15).font_semibold().child("Software Update"))
        .child(div().text_size(10.5).text_color(t.dim).child("Kent layout for Herdr")))
      .child(h_flex().flex_1())
      .when(Boolean(installedBadge), (el) => el.child(installedBadge));

    const heroTitle = h_flex().items_center().gap(8)
      .child(div().text_size(21).font_bold().child(headline))
      .when(Boolean(statusPill), (el) => el.child(statusPill));
    const hero = v_flex().pt(18).gap(4)
      .child(heroTitle)
      .child(div().text_size(11.5).text_color(t.dim).max_w(500).child(subtitle));

    let progressBlock = null;
    if (progress) {
      const track = div().h(5).w_full().rounded(3).bg(t.input).overflow_hidden()
        .child(div().h(5).w(`${Math.max(0, Math.min(100, Math.round(progress.pct)))}%`).rounded(3).bg(t.accent));
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
        .child(div().text_size(9.5).font_semibold().text_color(destructive).child("UPDATE ERROR"))
        .child(div().text_size(11.5).text_color(destructive).max_h(64).overflow_hidden()
          .tooltip(error).child(error));
      errorBlock = v_flex().pt(14).child(card);
    }

    let notesBlock = null;
    if (!error && info.notes && (available || current || this.busy || this.updated)) {
      const card = v_flex().p(12).gap(4).rounded(8).bg(t.raised).border_1().border_color(t.input)
        .child(div().text_size(9.5).font_semibold().text_color(t.dim).child("RELEASE NOTES"))
        .child(div().text_size(11.5).text_color(t.muted).max_h(52).overflow_hidden()
          .tooltip(String(info.notes)).child(String(info.notes)));
      notesBlock = v_flex().pt(14).child(card);
    }

    const actions = h_flex().items_center().gap(8).justify_end()
      .when(!this.busy && !this.updated, (el) => el.child(button(
        "kent-update-check", "Check again", false, !this.checkingNow,
        () => this.checkNow(cx),
      )))
      .when(available && !this.busy && !this.checkingNow && !this.updated, (el) => el.child(button(
        "kent-update-later", "Later", false, true, () => this.later(),
      )))
      .when(!this.busy && !this.updated, (el) => el.child(button(
        "kent-update-close", "Close", false, true,
        () => { if (overlay) closeOverlay(overlay); },
      )))
      .when(available && !this.busy && !this.checkingNow && !this.updated, (el) => el.child(button(
        "kent-update-install", "Update now", true, true, () => this.startInstall(cx),
      )))
      .when(this.busy, (el) => el.child(button(
        "kent-update-install", "Updating...", true, false, () => {},
      )))
      .when(this.updated, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("Closing...")));

    const footer = h_flex().items_center().gap(10)
      .child(div().text_size(10).text_color(t.dim).child(this.lastCheckedLabel(info)))
      .child(h_flex().flex_1())
      .child(actions);

    return v_flex()
      .id("kent-updater")
      .size_full()
      .min_h(0)
      .p(20)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(header)
      .child(hero)
      .when(Boolean(progressBlock), (el) => el.child(progressBlock))
      .when(Boolean(errorBlock), (el) => el.child(errorBlock))
      .when(Boolean(notesBlock), (el) => el.child(notesBlock))
      .child(h_flex().flex_1())
      .child(footer);
  }
}
