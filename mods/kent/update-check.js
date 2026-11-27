// Read-only update check for the Spaces sidebar. The installer lives in
// kent-updater; this module only reads a tiny manifest and reports a new
// version, so the always-visible sidebar can show a chip without owning any
// write path.

import { appHome, notify, readTextFile, setShared, shared, updates } from "herdr";

const REPO = "bioShaun/herdr-kent";
const REF = "main";
const MANIFEST = "manifest.json";
const USER_AGENT = "Kent-Updater";

function parseVersion(value) {
  const raw = String(value ?? "").trim().replace(/^v/i, "").split("+")[0];
  const dash = raw.indexOf("-");
  const core = dash >= 0 ? raw.slice(0, dash) : raw;
  const pre = dash >= 0 ? raw.slice(dash + 1) : null;
  return {
    nums: core.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    }),
    pre,
  };
}

function comparePre(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (i >= as.length) return -1;
    if (i >= bs.length) return 1;
    const an = /^\d+$/.test(as[i]);
    const bn = /^\d+$/.test(bs[i]);
    if (an && bn) {
      const d = Number(as[i]) - Number(bs[i]);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

async function localVersion() {
  const raw = await readTextFile(`${appHome()}/kent-version.json`).catch(() => null);
  if (!raw) return "0.0.0";
  try {
    const manifest = JSON.parse(raw);
    return typeof manifest?.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function getText(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function remoteManifest() {
  let ref = REF;
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/commits/${REF}`, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/vnd.github+json" },
    });
    if (response.ok) {
      const data = await response.json().catch(() => null);
      if (data?.sha) ref = String(data.sha);
    }
  } catch {
    ref = REF;
  }
  let raw = null;
  if (ref !== REF) raw = await getText(`https://raw.githubusercontent.com/${REPO}/${ref}/${MANIFEST}`).catch(() => null);
  if (!raw) raw = await getText(`https://raw.githubusercontent.com/${REPO}/${REF}/${MANIFEST}?t=${Date.now()}`);
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest !== "object" || typeof manifest.version !== "string" || !Array.isArray(manifest.files)) {
    throw new Error("manifest.json is invalid");
  }
  return manifest;
}

function appVersion() {
  try {
    return String(updates()?.app?.version ?? "");
  } catch {
    return "";
  }
}

export async function checkKentUpdate() {
  const current = await localVersion();
  let remote;
  try {
    remote = await remoteManifest();
  } catch (error) {
    const info = { status: "error", error: String(error?.message ?? error), currentVersion: current, checkedAt: Date.now() };
    setShared("kent.update", info);
    return info;
  }
  const latest = remote.version;
  const newer = compareVersions(latest, current) > 0;
  const minHerdr = typeof remote.minHerdr === "string" ? remote.minHerdr : null;
  const thisApp = appVersion();
  const compatible = !minHerdr || !thisApp || compareVersions(thisApp, minHerdr) >= 0;
  const info = {
    status: newer ? (compatible ? "available" : "unsupported") : "current",
    version: latest,
    currentVersion: current,
    notes: String(remote.notes ?? ""),
    minHerdr,
    appVersion: thisApp,
    checkedAt: Date.now(),
  };
  setShared("kent.update", info);
  if (info.status === "available"
    && shared("kent.notified-version") !== latest
    && shared("kent.dismissed-version") !== latest) {
    notify({
      title: "Kent update available",
      body: `Kent ${latest} is out${info.notes ? ` · ${info.notes}` : ""} · Click to update`,
      level: "info",
      timeout: 10000,
      action: { name: "mod.open", args: { name: "kent-updater" } },
    });
    setShared("kent.notified-version", latest);
  }
  return info;
}
