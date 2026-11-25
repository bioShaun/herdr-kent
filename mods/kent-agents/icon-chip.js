// Theme-aware program icon chips. Filled artwork is fitted by its visible
// vector bounds, while stroke-only utility icons keep their designed padding.

import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { ICON_METRICS } from "./icon-metrics.js";

const base = (path) => (path ?? "").split("/").pop();

// The generated table describes Herdr's shipped icon folder. A custom icon that
// happens to reuse the same file name elsewhere must not inherit those bounds.
function shippedMetric(path) {
  const clean = (path ?? "").replace(/\\/g, "/");
  if (!clean.startsWith("icons/") && !clean.includes("/herdr-app/icons/")) return null;
  return ICON_METRICS[base(clean)] ?? null;
}

export function darkSurface(color, fallback = true) {
  const m = /^#([0-9a-f]{6})/i.exec(color ?? "");
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

function aspectFit(ratio, maxW, maxH) {
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  return [w, h];
}

// Keep the direction of very wide/tall artwork without making extreme pills:
// ratios outside 0.625–1.6 are compressed to that range.
function softAspect(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  const sign = ratio >= 1 ? 1 : -1;
  return Math.exp(sign * Math.min(Math.abs(Math.log(ratio)), Math.log(1.6)));
}

function placeArtwork(el, left, top, width, height) {
  return el.absolute().left(left).top(top).w(width).h(height).flex_none();
}

export function iconChip(p, t, { slot = 20, max = 18, color = null, empty = false } = {}) {
  if (!p?.icon && !empty) return null;
  const dark = darkSurface(t.chrome, t.is_dark !== false);
  const edgeHot = dark ? "#ffffff26" : "#00000024";
  const edgeMid = dark ? "#ffffff14" : "#00000014";
  const edgeLow = dark ? "#ffffff06" : "#00000006";
  const edgeBase = dark ? "#ffffff06" : "#00000005";

  const path = p?.icon;
  const metric = path ? shippedMetric(path) : null;
  const stroke = metric?.[6] === 1;
  const viewRatio = metric?.[1] ?? 1;
  const visualRatio = metric?.[0] ?? viewRatio;
  const [chipW, chipH] = aspectFit(softAspect(stroke ? viewRatio : visualRatio), max, max);
  const radius = Math.min(7, chipH / 2);

  // Stroke glyphs (terminal, shell, nano...) need their built-in whitespace.
  // Filled brand artwork is optically fitted, even when it is tintable.
  const line = stroke || !path;
  const padX = line ? 5.5 : 2.5;
  const padY = line ? 5 : 2.5;
  const maxVisualW = Math.max(6, chipW - padX);
  const maxVisualH = Math.max(6, chipH - padY);

  const fillW = !stroke && metric ? metric[2] : 1;
  const fillH = !stroke && metric ? metric[3] : 1;
  const centerX = !stroke && metric ? metric[4] : 0.5;
  const centerY = !stroke && metric ? metric[5] : 0.5;
  let artH = Math.min(maxVisualW / (fillW * viewRatio), maxVisualH / fillH);
  if (!Number.isFinite(artH) || artH <= 0) artH = Math.min(maxVisualW, maxVisualH);
  const artW = artH * viewRatio;

  // Center the visible bounds, not the SVG viewport. Transparent portions may
  // extend beyond the chip and are clipped, while the visible artwork remains centered.
  const innerW = Math.max(1, chipW - 2);
  const innerH = Math.max(1, chipH - 2);
  const left = innerW / 2 - centerX * artW;
  const top = innerH / 2 - centerY * artH;

  const art = !path
    ? placeArtwork(svg("mods/workspace-chrome/terminal.svg"), left, top, artW, artH).text_color(t.muted)
    : !p.tint
      ? placeArtwork(image(path), left, top, artW, artH)
      : placeArtwork(svg(path), left, top, artW, artH).text_color(p.color ?? color ?? (dark ? t.foreground : t.muted));

  return h_flex()
    .size(slot)
    .flex_none()
    .items_center()
    .justify_center()
    .child(h_flex()
      .w(chipW)
      .h(chipH)
      .rounded(radius)
      .relative()
      .bg(edgeBase)
      .child(div().absolute().top(0).left(1).right(1).h(1).bg(edgeHot))
      .child(div().absolute().left(0).top(1).bottom(1).w(1).bg(edgeMid))
      .child(div().absolute().bottom(0).left(1).right(1).h(1).bg(edgeLow))
      .child(div().absolute().right(0).top(1).bottom(1).w(1).bg(edgeLow))
      .child(h_flex()
        .absolute()
        .inset(1)
        .rounded(Math.max(3, radius - 1))
        .bg(p?.tile ?? (!path ? t.raised : dark ? "#ffffff04" : "#00000004"))
        .overflow_hidden()
        .child(art)));
}
