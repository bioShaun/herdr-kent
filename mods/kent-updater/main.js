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
    this.logs = [];
    this.busy = false;
    this.checkingNow = false;
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

  log(cx, line) {
    this.logs.push(String(line));
    if (this.logs.length > 7) this.logs = this.logs.slice(-7);
    this.notify(cx);
  }

  checkNow(cx) {
    if (this.busy || this.checkingNow) return;
    this.checkingNow = true;
    this.error = "";
    this.log(cx, "Checking GitHub...");
    cx.spawn(async (cx) => {
      try {
        const result = await checkForUpdate();
        this.info = result.info;
        this.remote = result.remote;
        this.localVersion = result.info.currentVersion ?? this.localVersion;
      } catch (error) {
        this.error = String(error?.message ?? error);
      } finally {
        this.checkingNow = false;
        this.notify(cx);
      }
    });
  }

  startInstall(cx) {
    if (this.busy || this.info?.status !== "available") return;
    this.busy = true;
    this.error = "";
    this.logs = [];
    this.log(cx, `Preparing Kent ${this.info.version}...`);
    cx.spawn(async (cx) => {
      try {
        const remote = this.remote && this.remote.manifest?.version === this.info.version
          ? this.remote
          : await fetchRemoteManifest();
        const result = await installUpdate(remote, (line) => this.log(cx, line));
        this.info = { status: "current", version: result.version, currentVersion: result.version, checkedAt: Date.now() };
        this.localVersion = result.version;
        this.log(cx, `Done. Backup: ${result.backupDir}`);
      } catch (error) {
        this.error = String(error?.message ?? error);
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

  render(cx) {
    const t = theme();
    const overlay = props()?.overlay;
    const info = this.info ?? {};
    const detail = this.error || (info.status === "error" ? info.error : "");
    const available = info.status === "available";
    const unsupported = info.status === "unsupported";
    const current = info.status === "current";
    const statusLine = this.busy
      ? "Updating..."
      : this.checkingNow
        ? "Checking..."
        : available
          ? `Kent ${info.version} is available`
          : unsupported
            ? `Kent ${info.version} needs Herdr ${info.minHerdr} or newer (this is ${info.appVersion || "unknown"})`
            : current
              ? `Kent ${info.version} is up to date`
              : "Could not check for updates";

    const button = (id, text, primary, enabled, action) => h_flex()
      .id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .when(!enabled, (el) => el.opacity(0.45))
      .child(text);

    const buttons = h_flex().gap(8).justify_end()
      .child(button("kent-update-check", "Check again", false, !this.busy && !this.checkingNow, () => this.checkNow(cx)))
      .child(button("kent-update-later", "Later", false, available && !this.busy, () => this.later()))
      .child(button("kent-update-close", "Close", false, !this.busy, () => { if (overlay) closeOverlay(overlay); }))
      .child(button("kent-update-install", this.busy ? "Updating..." : "Update now", true, available && !this.busy, () => this.startInstall(cx)));

    return v_flex()
      .id("kent-updater")
      .size_full()
      .min_h(0)
      .p(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(15).font_semibold().child("Kent updates"))
        .child(div().text_size(11).text_color(t.dim).child(this.localVersion === "…" ? "" : `installed ${this.localVersion}`)))
      .child(div().pt(8).text_size(12.5).text_color(available ? t.accent : t.muted).child(statusLine))
      .when(Boolean(info.notes) && (available || current), (el) => el.child(div().pt(2).text_size(11.5).text_color(t.dim).max_w(500).truncate().child(info.notes)))
      .child(v_flex().pt(10).gap(3).min_h(92).max_h(112).p(9).rounded(8).bg(t.background).border_1().border_color(t.input)
        .when(this.logs.length === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("No update log yet.")))
        .children(this.logs.map((line) => div().text_size(11).text_color(t.dim).max_w(500).truncate().child(line))))
      .when(Boolean(detail), (el) => el.child(div().text_size(11.5).text_color(t.blocked ?? t.danger ?? "#f38ba8").max_w(500).truncate().tooltip(detail).child(detail)))
      .child(h_flex().flex_1())
      .child(buttons);
  }
}
