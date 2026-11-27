// The Kent update engine: discover, verify, stage, check, back up, write, roll
// back. It lives in kent-updater, which is not part of the manifest it installs;
// a broken Kent release therefore cannot take the repair path down with it.

import { appHome, exec, readTextFile, writeTextFile, setShared, updates, window, notify } from "herdr";
import * as fs from "fs/promises";
import { canonicalText, compareVersions, managedPath, sha256Hex, utf8Length, validateManifest } from "./core.js";

export const REPO = "bioShaun/herdr-kent";
export const REF = "main";
const MANIFEST = "manifest.json";
const LOCAL_MANIFEST = "kent-version.json";
const STAGING = "data/kent-update";
const USER_AGENT = "Kent-Updater";

const homePath = (path) => `${appHome().replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "") + "-" + Math.floor(Math.random() * 1000);

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept": "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${url}`);
  return res.text();
}

async function readManifestAt(ref, cacheBust) {
  const url = `https://raw.githubusercontent.com/${REPO}/${ref}/${MANIFEST}${cacheBust ? `?t=${Date.now()}` : ""}`;
  const raw = await getText(url);
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`manifest.json is not valid JSON: ${error?.message ?? error}`);
  }
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`manifest.json is invalid:\n  ${problems.join("\n  ")}`);
  return { manifest, raw, ref, sha256: sha256Hex(raw) };
}

// Read version.json at the commit named by the branch first: a raw main URL can
// be a CDN-cached copy from before the release. Fall back to main with a
// cache-buster only when the API is rate-limited or unreachable.
export async function fetchRemoteManifest() {
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
  if (ref !== REF) {
    try {
      return await readManifestAt(ref, false);
    } catch {
      // A vanished commit or a raw hiccup: the branch copy is still a valid release.
    }
  }
  return readManifestAt(REF, true);
}

export async function readLocalManifest() {
  const raw = await readTextFile(homePath(LOCAL_MANIFEST)).catch(() => null);
  if (!raw) return { manifest: { version: "0.0.0", files: [], deleted: [] }, raw: null };
  try {
    const manifest = JSON.parse(raw);
    if (manifest && typeof manifest === "object") return { manifest, raw };
  } catch {}
  return { manifest: { version: "0.0.0", files: [], deleted: [] }, raw, malformed: true };
}

function appVersion() {
  try {
    return String(updates()?.app?.version ?? "");
  } catch {
    return "";
  }
}

export async function checkForUpdate() {
  const local = await readLocalManifest();
  let remote;
  try {
    remote = await fetchRemoteManifest();
  } catch (error) {
    const info = {
      status: "error",
      error: String(error?.message ?? error),
      currentVersion: local.manifest.version ?? "0.0.0",
      checkedAt: Date.now(),
    };
    setShared("kent.update", info);
    return { info, remote: null };
  }

  const latest = remote.manifest.version;
  const current = local.manifest.version ?? "0.0.0";
  const newer = compareVersions(latest, current) > 0;
  const minHerdr = remote.manifest.minHerdr ?? null;
  const currentApp = appVersion();
  const compatible = !minHerdr || !currentApp || compareVersions(currentApp, minHerdr) >= 0;
  const status = newer ? (compatible ? "available" : "unsupported") : "current";
  const info = {
    status,
    version: latest,
    currentVersion: current,
    notes: String(remote.manifest.notes ?? ""),
    minHerdr,
    appVersion: currentApp,
    checkedAt: Date.now(),
  };
  setShared("kent.update", info);
  return { info, remote };
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

async function runHerdrCheck(modDir, stageRoot, session) {
  const timeout = 60000;
  if (window()?.platform === "windows") {
    const command = `$env:HERDR_APP_HOME='${psQuote(stageRoot)}'; $env:HC_SESSION='${session}'; & herdr-app check '${psQuote(modDir)}'`;
    return exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout });
  }
  return exec(
    "sh",
    ["-c", 'HERDR_APP_HOME="$1" HC_SESSION="$2" herdr-app check "$3"', "sh", stageRoot, session, modDir],
    { timeout },
  );
}

async function stopStagedCore(stageRoot, session) {
  const timeout = 15000;
  try {
    if (window()?.platform === "windows") {
      const command = `$env:HERDR_APP_HOME='${psQuote(stageRoot)}'; $env:HC_SESSION='${session}'; & hc server stop`;
      await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout });
    } else {
      await exec("sh", ["-c", 'HERDR_APP_HOME="$1" HC_SESSION="$2" hc server stop', "sh", stageRoot, session], { timeout });
    }
  } catch {
    // The check already passed or failed; a leftover one-shot core is not fatal.
  }
}

async function checkStagedMods(stageRoot, log) {
  const session = `kent-update-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  try {
    for (const mod of ["kent", "kent-agents"]) {
      log(`Checking staged mods/${mod}...`);
      const result = await runHerdrCheck(`${stageRoot}/mods/${mod}`, stageRoot, session).catch((error) => {
        throw new Error(`could not run herdr-app check: ${error?.message ?? error}`);
      });
      if (result.code !== 0) {
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
        throw new Error(`staged mods/${mod} failed herdr-app check${output ? `:\n${output}` : ""}`);
      }
    }
  } finally {
    await stopStagedCore(stageRoot, session);
  }
}

async function removePath(path) {
  if (!(await fs.exists(path))) return;
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await removePath(child);
      else await fs.unlink(child);
    }
    await fs.rmdir(path);
  } catch {
    await fs.unlink(path).catch(() => {});
  }
}

async function writeBackup(backupDir, path, content) {
  const target = `${backupDir}/${path}`;
  await fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await fs.writeFile(target, content);
}

async function restore(path, old) {
  const full = homePath(path);
  const current = await readTextFile(full).catch(() => null);
  if (old === null || old === undefined) {
    await removePath(full);
    return;
  }
  try {
    await writeTextFile(full, old, current);
  } catch {
    // A rollback must land even if another writer moved the file: write past CAS.
    await fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(full, old);
  }
}

async function writeManaged(path, content, old) {
  await writeTextFile(homePath(path), content, old ?? null);
}

export async function installUpdate(remote, log = () => {}) {
  const manifest = remote?.manifest;
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`manifest.json is invalid:\n  ${problems.join("\n  ")}`);
  const local = await readLocalManifest();
  const oldFiles = new Map();

  const union = new Set([
    ...manifest.files.map((entry) => entry.path),
    ...(manifest.deleted ?? []),
    ...(Array.isArray(local.manifest.files) ? local.manifest.files.map((entry) => entry.path) : []),
  ]);
  for (const path of union) {
    if (managedPath(path)) oldFiles.set(path, await readTextFile(homePath(path)).catch(() => null));
  }

  log(`Downloading ${manifest.files.length} files from ${String(remote.ref).slice(0, 8)}...`);
  const nextFiles = new Map();
  for (const [index, entry] of manifest.files.entries()) {
    log(`Downloading ${entry.path} (${index + 1}/${manifest.files.length})...`);
    const url = `https://raw.githubusercontent.com/${REPO}/${remote.ref}/${entry.path}?t=${Date.now()}`;
    const content = canonicalText(await getText(url));
    if (sha256Hex(content) !== entry.sha256) throw new Error(`${entry.path}: SHA-256 does not match the manifest`);
    if (utf8Length(content) !== entry.size) throw new Error(`${entry.path}: size does not match the manifest`);
    nextFiles.set(entry.path, content);
  }
  log(`Verified ${nextFiles.size} files.`);

  try {
    JSON.parse(nextFiles.get("layouts/kent.json"));
  } catch (error) {
    throw new Error(`layouts/kent.json is not valid JSON: ${error?.message ?? error}`);
  }

  const stageRoot = homePath(`${STAGING}/staging-${stamp()}`);
  await fs.mkdir(stageRoot, { recursive: true });
  try {
    for (const [path, content] of nextFiles) {
      if (!path.startsWith("mods/kent/") && !path.startsWith("mods/kent-agents/")) continue;
      const target = `${stageRoot}/${path}`;
      await fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(target, content);
    }
    await checkStagedMods(stageRoot, log);
    log("Staged mods check passed.");
  } finally {
    await removePath(stageRoot).catch(() => {});
  }

  const backupDir = homePath(`kent-backup-${stamp()}`);
  for (const [path, old] of oldFiles) {
    if (old !== null && old !== undefined) await writeBackup(backupDir, path, old);
  }
  if (local.raw !== null && local.raw !== undefined) await writeBackup(backupDir, LOCAL_MANIFEST, local.raw);
  log(`Backed up the installed files to ${backupDir}.`);

  const written = [];
  const removed = [];
  try {
    for (const [path, content] of nextFiles) {
      if (!path.startsWith("mods/")) continue;
      await writeManaged(path, content, oldFiles.get(path));
      written.push(path);
    }
    for (const path of manifest.deleted ?? []) {
      if (!managedPath(path)) continue;
      await removePath(homePath(path));
      removed.push(path);
    }
    for (const [path, content] of nextFiles) {
      if (!path.startsWith("layouts/")) continue;
      await writeManaged(path, content, oldFiles.get(path));
      written.push(path);
    }
    // The version marker goes last: a half-finished update must keep asking to
    // be retried, not claim it is already current.
    const installed = {
      ...manifest,
      installedAt: Date.now(),
      manifestSha256: remote.sha256 ?? sha256Hex(remote.raw ?? ""),
    };
    const localText = JSON.stringify(installed, null, 2) + "\n";
    await writeTextFile(homePath(LOCAL_MANIFEST), localText, local.raw ?? null);
    written.push(LOCAL_MANIFEST);
  } catch (error) {
    for (const path of written.reverse()) await restore(path, oldFiles.get(path)).catch(() => {});
    for (const path of removed.reverse()) {
      const old = oldFiles.get(path);
      if (old !== null && old !== undefined) await restore(path, old).catch(() => {});
    }
    if (local.raw === null || local.raw === undefined) await removePath(homePath(LOCAL_MANIFEST)).catch(() => {});
    else await restore(LOCAL_MANIFEST, local.raw).catch(() => {});
    throw new Error(`update failed and was rolled back: ${error?.message ?? error}\nBackup: ${backupDir}`);
  }

  const info = {
    status: "current",
    version: manifest.version,
    currentVersion: manifest.version,
    notes: String(manifest.notes ?? ""),
    checkedAt: Date.now(),
  };
  setShared("kent.update", info);
  setShared("kent.dismissed-version", manifest.version);
  setShared("kent.notified-version", manifest.version);
  setShared("kent.last-install", { version: manifest.version, at: Date.now(), backupDir });
  notify({
    title: "Kent updated",
    body: `Kent ${manifest.version} is installed. Herdr reloads the layout in place.`,
    level: "success",
    timeout: 8000,
  });
  log(`Updated to ${manifest.version}. Backup: ${backupDir}`);
  return { ok: true, version: manifest.version, backupDir, changed: written.length, removed: removed.length };
}
