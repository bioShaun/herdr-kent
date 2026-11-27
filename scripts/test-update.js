#!/usr/bin/env node
// Unit harness for the Kent updater. It runs updater.js in a vm with a fake
// GitHub and a real temporary Herdr home, so verification, staging, backups,
// rollback and write order are exercised without touching the person's app.

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const childProcess = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CORE = path.join(ROOT, "mods", "kent-updater", "core.js");
const UPDATER = path.join(ROOT, "mods", "kent-updater", "updater.js");
const REF = "abc123def456";

function stripExports(source) {
  return source
    .replace(/^import .*;\n/gm, "")
    .replace(/^export (const|function|async function|class)/gm, "$1");
}

async function load() {
  const coreSource = stripExports(await fs.readFile(CORE, "utf8"));
  const coreContext = { console, Math, Number, JSON, String, Array, Object, Set, Map, Promise, Uint8Array, Int32Array, DataView, Error };
  vm.createContext(coreContext);
  vm.runInContext(coreSource, coreContext);
  return coreContext;
}

function makeManifest(core, files) {
  return {
    version: "1.0.0",
    channel: "stable",
    minHerdr: "0.1.18",
    notes: "test release",
    files: Object.entries(files).map(([file, content]) => ({
      path: file,
      sha256: core.sha256Hex(content),
      size: core.utf8Length(content),
    })),
    deleted: [],
  };
}

function realExec(command, args, options = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, { timeout: options.timeout ?? 60000 }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function harness({ manifestFiles, oldFiles, failCheck = false, failWritePath = null, realCheck = false }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "kent-update-test-"));
  const core = await load();
  const manifest = makeManifest(core, manifestFiles);
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const shared = {};
  const writes = [];
  let checking = failCheck;
  let writePathToFail = failWritePath;

  const readTextFile = async (file) => {
    try { return await fs.readFile(file, "utf8"); } catch { return null; }
  };
  const writeTextFile = async (file, text, expected) => {
    const current = await readTextFile(file);
    if (current !== expected) throw new Error(`stale write: ${file}`);
    if (writePathToFail && file.endsWith(writePathToFail)) {
      writePathToFail = null;
      throw new Error("simulated write failure");
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    writes.push(file);
    return null;
  };
  const fakeFetch = async (url) => {
    if (url.includes("api.github.com/repos/")) {
      return { ok: true, status: 200, json: async () => ({ sha: REF }) };
    }
    if (url.includes("/manifest.json")) {
      return { ok: true, status: 200, text: async () => manifestText };
    }
    const marker = `/${REF}/`;
    const at = url.indexOf(marker);
    const relative = at >= 0 ? url.slice(at + marker.length).split("?")[0] : "";
    if (Object.prototype.hasOwnProperty.call(manifestFiles, relative)) {
      return { ok: true, status: 200, text: async () => manifestFiles[relative] };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => null };
  };
  const exec = async (command, args, options) => {
    if (!realCheck) {
      if (checking) return { code: 1, stdout: "", stderr: "simulated check failure" };
      return { code: 0, stdout: "check passed", stderr: "" };
    }
    return realExec(command, args, options);
  };

  await fs.mkdir(home, { recursive: true });
  for (const [relative, content] of Object.entries(oldFiles)) {
    const target = path.join(home, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const oldLocal = JSON.stringify({ version: "0.9.0", files: [], deleted: [] }, null, 2) + "\n";
  await fs.writeFile(path.join(home, "kent-version.json"), oldLocal);

  const updaterSource = stripExports(await fs.readFile(UPDATER, "utf8"));
  const context = {
    console, Math, Number, JSON, String, Array, Object, Set, Map, Promise, Date,
    Uint8Array, Int32Array, DataView, Error,
    appHome: () => home,
    readTextFile,
    writeTextFile,
    exec,
    fetch: fakeFetch,
    window: () => ({ platform: "darwin" }),
    updates: () => ({ app: { version: "0.1.18" } }),
    setShared: (key, value) => { shared[key] = value; return null; },
    notify: () => "id",
    fs,
    canonicalText: core.canonicalText,
    compareVersions: core.compareVersions,
    managedPath: core.managedPath,
    sha256Hex: core.sha256Hex,
    utf8Length: core.utf8Length,
    validateManifest: core.validateManifest,
  };
  vm.createContext(context);
  vm.runInContext(updaterSource, context);
  return { home, core, manifest, shared, writes, context, cleanup: () => fs.rm(home, { recursive: true, force: true }) };
}

async function testCore() {
  const core = await load();
  assert.strictEqual(core.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.strictEqual(core.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.strictEqual(core.compareVersions("1.0.0", "0.9.9"), 1);
  assert.strictEqual(core.compareVersions("1.0.0-beta.2", "1.0.0-beta.1"), 1);
  assert.strictEqual(core.compareVersions("1.0.0+local", "1.0.0"), 0);
  assert.deepStrictEqual(core.validateManifest({
    version: "1.0.0",
    files: [{ path: "../evil", sha256: "a".repeat(64), size: 1 }],
  }).some((line) => line.includes("not a Kent-managed file")), true);
}

async function testInstallSuccess() {
  const oldFiles = {
    "layouts/kent.json": "{\"old\":true}\n",
    "mods/kent/main.js": "// old kent\n",
    "mods/kent/mod.json": "{}\n",
    "mods/kent-agents/main.js": "// old agents\n",
  };
  const newFiles = {
    "layouts/kent.json": "{\"new\":true}\n",
    "mods/kent/main.js": "// new kent\n",
    "mods/kent/mod.json": "{}\n",
    "mods/kent-agents/main.js": "// new agents\n",
  };
  const h = await harness({ manifestFiles: newFiles, oldFiles });
  try {
    const remote = await h.context.fetchRemoteManifest();
    const progress = [];
    const result = await h.context.installUpdate(remote, (_line, step) => { if (step) progress.push(step); });
    assert.strictEqual(result.version, "1.0.0");
    const totalBytes = Object.values(newFiles).reduce((sum, content) => sum + h.core.utf8Length(content), 0);
    const lastDownload = progress.filter((step) => step.phase === "download").at(-1);
    assert.strictEqual(lastDownload?.current, totalBytes, "download progress is byte-weighted and reaches the end");
    assert.strictEqual(lastDownload?.total, totalBytes);
    assert.strictEqual(lastDownload?.file, 4, "the file count is still reported for the label");
    assert.strictEqual(lastDownload?.files, 4);
    assert.ok(progress.some((step) => step.phase === "stage" && step.current === step.total), "staged check progress reaches the end");
    assert.strictEqual(progress.at(-1)?.phase, "done");
    for (const [relative, content] of Object.entries(newFiles)) {
      assert.strictEqual(await fs.readFile(path.join(h.home, relative), "utf8"), content);
    }
    const local = JSON.parse(await fs.readFile(path.join(h.home, "kent-version.json"), "utf8"));
    assert.strictEqual(local.version, "1.0.0");
    assert.ok(local.manifestSha256);
    assert.deepStrictEqual(h.shared["kent.update"].status, "current");
    assert.ok(h.writes[h.writes.length - 1].endsWith("kent-version.json"), "version marker must be written last");
    const backup = h.shared["kent.last-install"].backupDir;
    assert.strictEqual(await fs.readFile(path.join(backup, "mods/kent/main.js"), "utf8"), "// old kent\n");
  } finally {
    await h.cleanup();
  }
}

async function testHashMismatch() {
  const oldFiles = { "layouts/kent.json": "{\"old\":true}\n", "mods/kent/main.js": "// old\n", "mods/kent/mod.json": "{}\n", "mods/kent-agents/main.js": "// old agents\n" };
  const newFiles = { ...oldFiles, "mods/kent/main.js": "// new\n" };
  const h = await harness({ manifestFiles: newFiles, oldFiles });
  try {
    const remote = await h.context.fetchRemoteManifest();
    remote.manifest.files.find((entry) => entry.path === "mods/kent/main.js").sha256 = "0".repeat(64);
    await assert.rejects(() => h.context.installUpdate(remote, () => {}), /SHA-256/);
    assert.strictEqual(await fs.readFile(path.join(h.home, "mods/kent/main.js"), "utf8"), "// old\n");
    assert.strictEqual(JSON.parse(await fs.readFile(path.join(h.home, "kent-version.json"), "utf8")).version, "0.9.0");
  } finally {
    await h.cleanup();
  }
}

async function testCheckFailure() {
  const oldFiles = { "layouts/kent.json": "{\"old\":true}\n", "mods/kent/main.js": "// old\n", "mods/kent/mod.json": "{}\n", "mods/kent-agents/main.js": "// old agents\n" };
  const newFiles = { ...oldFiles, "mods/kent/main.js": "// new\n" };
  const h = await harness({ manifestFiles: newFiles, oldFiles, failCheck: true });
  try {
    const remote = await h.context.fetchRemoteManifest();
    await assert.rejects(() => h.context.installUpdate(remote, () => {}), /failed herdr-app check/);
    assert.strictEqual(await fs.readFile(path.join(h.home, "mods/kent/main.js"), "utf8"), "// old\n");
    assert.strictEqual(JSON.parse(await fs.readFile(path.join(h.home, "kent-version.json"), "utf8")).version, "0.9.0");
  } finally {
    await h.cleanup();
  }
}

async function testRealStaging() {
  const managed = [
    "layouts/kent.json",
    "layouts/kent.svg",
    "mods/kent/main.js",
    "mods/kent/mod.json",
    "mods/kent/icon-chip.js",
    "mods/kent/icon-metrics.js",
    "mods/kent/update-check.js",
    "mods/kent-agents/main.js",
    "mods/kent-agents/mod.json",
    "mods/kent-agents/icon-chip.js",
    "mods/kent-agents/icon-metrics.js",
  ];
  const contents = {};
  for (const file of managed) contents[file] = await fs.readFile(path.join(ROOT, file), "utf8");
  const h = await harness({ manifestFiles: contents, oldFiles: contents, realCheck: true });
  try {
    const remote = await h.context.fetchRemoteManifest();
    const result = await h.context.installUpdate(remote, () => {});
    assert.strictEqual(result.version, "1.0.0");
    assert.strictEqual(await fs.readFile(path.join(h.home, "layouts/kent.json"), "utf8"), contents["layouts/kent.json"]);
  } finally {
    await h.cleanup();
  }
}

async function testRollback() {
  const oldFiles = { "layouts/kent.json": "{\"old\":true}\n", "mods/kent/main.js": "// old\n", "mods/kent/mod.json": "{}\n", "mods/kent-agents/main.js": "// old agents\n" };
  const newFiles = { ...oldFiles, "mods/kent/main.js": "// new\n", "mods/kent-agents/main.js": "// new agents\n" };
  const h = await harness({ manifestFiles: newFiles, oldFiles, failWritePath: "mods/kent-agents/main.js" });
  try {
    const remote = await h.context.fetchRemoteManifest();
    await assert.rejects(() => h.context.installUpdate(remote, () => {}), /rolled back/);
    assert.strictEqual(await fs.readFile(path.join(h.home, "mods/kent/main.js"), "utf8"), "// old\n");
    assert.strictEqual(await fs.readFile(path.join(h.home, "mods/kent-agents/main.js"), "utf8"), "// old agents\n");
    assert.strictEqual(JSON.parse(await fs.readFile(path.join(h.home, "kent-version.json"), "utf8")).version, "0.9.0");
  } finally {
    await h.cleanup();
  }
}

(async () => {
  await testCore();
  await testInstallSuccess();
  await testHashMismatch();
  await testCheckFailure();
  await testRollback();
  if (childProcess.spawnSync("herdr-app", ["--version"]).status === 0) {
    await testRealStaging();
  } else {
    console.log("herdr-app not on PATH; skipping the real staging check");
  }
  console.log("update tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
