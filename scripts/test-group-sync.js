#!/usr/bin/env node
// Unit harness for Kent's per-machine group synchronization logic. It loads
// main.js in a vm with the Herdr API stubbed, so no Herdr app or core is touched.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const os = require('os');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'mods', 'kent', 'main.js');
const STORE = 'kent.groups.v1';
const MIGRATED_KEY = 'kent.groups.sync.migrated';
const PENDING_KEY = 'kent.groups.pending.v1';
const VERSIONS_KEY = 'kent.groups.sync.versions';

function loadKent({ sharedData = {}, storage = {}, spacesList = [], machineList = [], agentsList = [], execImpl = null, platform = null } = {}) {
  let source = fs.readFileSync(MAIN, 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  source = source.replace(/export function /g, 'function ');
  source = source.replace(/export default class /, 'class ');
  source += `\nglobalThis.__kent = {
    bareSpaceId, clientSpaceId, emptyMachineData, normalizeMachineData,
    readLegacyShared, legacyMachineData, mergeLegacyData, machineStore,
    syncMachineNames, readStore, writeLegacySnapshot, applyGroupIntent,
    enqueueGroupOp, restorePendingGroupOps, coreRpc, docGet, docSet,
    rebuildOptimistic, adoptRemote, processGroupOp, pruneMachineData,
    pendingGroupOps, clearPendingGroupOp, startGroupSync, stopGroupSync, groupSync, Spaces,
    readProjects, projectEntries, rememberProject, forgetProject, projectKeyOf, normPath,
    agentMachine, agentsOnMachine, firstAgentOnMachine, parkedMachineNames,
    rememberTemporaryMachines, isTemporaryMachine, parseGroupDocEvent, eventsLookUnsupported,
    waitGroupDocEvent, refreshGroupDocs,
  };`;

  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
    setItem(k, v) { storage[k] = String(v); },
    removeItem(k) { delete storage[k]; },
  };
  const context = {
    console,
    Date, Math, JSON, Set, Map, Promise, Array, Object, String, Number, Boolean, Error,
    localStorage,
    shared: (k) => sharedData[k],
    setShared: (k, v) => { sharedData[k] = v; },
    spaces: () => spacesList,
    machines: () => machineList, // the other machines' layout documents: this computer has no entry
    agents: () => agentsList,
    panes: () => [],
    run: () => {},
    openOverlay: () => {}, closeOverlay: () => {}, props: () => null,
    exec: execImpl || (async () => ({ code: 1, stdout: '', stderr: 'exec not stubbed' })),
    hc: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    theme: () => ({}),
    watchFolder: () => ({ cancel: () => {} }),
    window: () => ({ platform: platform ?? (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'), active: false, visible: true }),
    layout: () => null,
    nextCommand: async () => new Promise(() => {}),
    checking: () => false,
    View: class {},
    div: () => { throw new Error('ui not available in test'); },
    svg: () => { throw new Error('ui not available in test'); },
    v_flex: () => { throw new Error('ui not available in test'); },
    h_flex: () => { throw new Error('ui not available in test'); },
    ScrollHandle: { new: () => ({}) },
    InputState: { new: () => ({}) },
    Input: { new: () => ({}) },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'main.js' });
  return { kent: context.__kent, sharedData, storage, context };
}

function fakeCore({ fail = null, conflictOnce = false } = {}) {
  const docs = new Map();
  let setCount = 0;
  const keyFor = (machine) => machine ?? '';
  const getDoc = (machine) => {
    const key = keyFor(machine);
    if (!docs.has(key)) docs.set(key, { value: null, version: 0 });
    return docs.get(key);
  };
  const exec = async (cmd, args) => {
    let input;
    if (cmd === 'sh') input = args[2];
    else if (cmd === 'powershell') input = args[2].match(/\$payload = @'\n([\s\S]*)'@\n/)?.[1];
    else throw new Error(`unexpected exec ${cmd}`);
    if (typeof input !== 'string') throw new Error('could not extract hc-connect input');
    const responses = [];
    for (const line of input.trim().split('\n')) {
      const request = JSON.parse(line);
      const respond = (result) => responses.push({ jsonrpc: '2.0', id: request.id, result });
      const error = (kind, message = kind, code = -32000) => responses.push({ jsonrpc: '2.0', id: request.id, error: { code, message, data: { kind } } });
      if (fail) {
        const failure = fail(request);
        if (failure) { error(failure.kind, failure.message, failure.code); continue; }
      }
      if (request.method === 'doc.get') {
        const doc = getDoc(request.params.on ?? null);
        respond({ value: doc.value, version: doc.version });
      } else if (request.method === 'doc.set') {
        const doc = getDoc(request.params.on ?? null);
        setCount += 1;
        if (conflictOnce && setCount === 1) {
          doc.value = { groups: [{ id: 'remote', name: 'Remote', folded: false }], in: { remote: [] }, defaultFolded: false, at: 1 };
          doc.version += 1;
          error('conflict');
        } else if (request.params.version !== doc.version) {
          error('conflict');
        } else {
          doc.value = request.params.value;
          doc.version += 1;
          respond({ version: doc.version });
        }
      } else {
        error('unknown_method', 'unknown method', -32601);
      }
    }
    return { code: 0, stdout: responses.map((r) => JSON.stringify(r)).join('\n') + '\n', stderr: '' };
  };
  return { exec, docs, getDoc };
}

async function testCanonical() {
  const { kent } = loadKent();
  assert.equal(kent.bareSpaceId('4090/spabc', '4090'), 'spabc');
  assert.equal(kent.bareSpaceId('gpu/spabc', '4090'), 'gpu/spabc');
  assert.equal(kent.clientSpaceId('spabc', '4090'), '4090/spabc');
  assert.equal(kent.clientSpaceId('spabc', null), 'spabc');
  const normalized = kent.normalizeMachineData({
    groups: [{ id: 'g1', name: 'One', folded: false }],
    in: { g1: ['4090/sp1', 'gpu/sp2', 'sp3', 'sp1', ''] },
    defaultFolded: true,
  }, '4090');
  assert.deepEqual(normalized.in.g1, ['sp1', 'sp3']);
}

async function testUnicodeRpc() {
  const core = fakeCore();
  const { kent } = loadKent({ execImpl: core.exec });
  await kent.docSet(null, { groups: [{ id: 'g', name: '代码 🖥️', folded: false }], in: { g: [] }, defaultFolded: false }, 0);
  const got = await kent.docGet(null);
  assert.equal(got.value.groups[0].name, '代码 🖥️');
}


async function testWindowsRpcPayloadShape() {
  const core = fakeCore();
  const { kent } = loadKent({ execImpl: core.exec, platform: 'windows' });
  await kent.docSet(null, { groups: [{ id: 'g', name: '代码', folded: false }], in: { g: [] }, defaultFolded: false }, 0);
  const got = await kent.docGet(null);
  assert.equal(got.value.groups[0].name, '代码');
}

async function testMigration() {
  const core = fakeCore();
  const sharedData = {
    [STORE]: {
      version: 1,
      groups: [{ id: 'legacyg', name: 'Work', machine: '4090', folded: true }],
      in: { legacyg: ['4090/sp1', 'sp2'] },
      defaultFolded: { '4090': true },
    },
  };
  const machineList = [{ name: '4090', layout: 'ready' }];
  const spacesList = [
    { id: '4090/sp1', machine: '4090' },
    { id: '4090/sp2', machine: '4090' },
  ];
  const { kent } = loadKent({ sharedData, machineList, spacesList, execImpl: core.exec });
  const st = kent.machineStore('4090');
  assert.equal(st.queue.length, 1, 'migration queued');
  await kent.processGroupOp(st, st.queue.shift());
  const doc = core.getDoc('4090');
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.value.in.legacyg, ['sp1', 'sp2']);
  assert.equal(doc.value.defaultFolded, true);
  assert.equal(Boolean(sharedData[MIGRATED_KEY]?.['4090']), true);
  const view = kent.readStore();
  assert.deepEqual(view.in.legacyg, ['4090/sp1', '4090/sp2']);
}

async function testLegacyAliasMigration() {
  const { kent } = loadKent({
    sharedData: {
      [STORE]: {
        groups: [{ id: 'renamedg', name: 'Renamed machine', machine: '4090', folded: false }],
        in: { renamedg: ['oldalias/sp9'] },
      },
    },
  });
  assert.deepEqual(kent.legacyMachineData('4090').in.renamedg, ['sp9']);
}

async function testMigrationMergesByNameAndRemoteWins() {
  const core = fakeCore();
  const remote = core.getDoc('4090');
  remote.value = {
    groups: [{ id: 'remoteg', name: 'Work', folded: false }],
    in: { remoteg: ['sp1'] },
    defaultFolded: false,
    at: 1,
  };
  remote.version = 1;
  const sharedData = {
    [STORE]: {
      groups: [{ id: 'legacyg', name: 'Work', machine: '4090', folded: true }],
      in: { legacyg: ['4090/sp1', '4090/sp2'] },
      defaultFolded: { '4090': true },
    },
  };
  const machineList = [{ name: '4090', layout: 'ready' }];
  const spacesList = ['sp1', 'sp2'].map((id) => ({ id: `4090/${id}`, machine: '4090' }));
  const { kent } = loadKent({ sharedData, machineList, spacesList, execImpl: core.exec });
  const st = kent.machineStore('4090');
  kent.enqueueGroupOp('4090', { type: 'rename', id: 'legacyg', name: 'Work renamed' }, { label: 'rename' });
  await kent.processGroupOp(st, st.queue.shift());
  assert.equal(st.queue[0]?.intent.id, 'remoteg', 'migration rewrites queued intents to the merged group id');
  assert.equal(sharedData[PENDING_KEY]?.['4090']?.[0]?.intent?.id, 'remoteg', 'persisted pending intent is rewritten too');
  await kent.processGroupOp(st, st.queue.shift());
  const doc = core.getDoc('4090');
  assert.deepEqual(doc.value.groups.map((g) => g.id), ['remoteg'], 'same-named legacy group merges rather than duplicates');
  assert.equal(doc.value.groups[0].name, 'Work renamed', 'queued legacy rename survives the id merge');
  assert.equal(doc.value.groups[0].folded, false, 'remote group metadata wins');
  assert.deepEqual(doc.value.in.remoteg, ['sp1', 'sp2']);
  assert.equal(doc.value.defaultFolded, false, 'written remote default fold wins');
}

async function testCreateConflictAndIdentity() {
  const core = fakeCore({ conflictOnce: true });
  const machineList = [];
  const spacesList = [{ id: 'sp1', machine: null }];
  const { kent } = loadKent({ machineList, spacesList, execImpl: core.exec });
  const st = kent.machineStore(null);
  kent.enqueueGroupOp(null, { type: 'create', id: 'newg', name: 'Remote', space: 'sp1' }, { label: 'create' });
  assert.equal(st.queue.length, 1);
  await kent.processGroupOp(st, st.queue.shift());
  const doc = core.getDoc(null);
  const names = doc.value.groups.map((g) => [g.id, g.name]);
  assert.deepEqual(names, [['remote', 'Remote'], ['newg', 'Remote']]);
  assert.deepEqual(doc.value.in.newg, ['sp1']);
}

async function testMoveAndAssignAreCanonical() {
  const core = fakeCore();
  const machine = '4090';
  const machineList = [{ name: machine, layout: 'ready' }];
  const spacesList = ['sp1', 'sp2', 'sp3'].map((id) => ({ id: `${machine}/${id}`, machine }));
  const { kent } = loadKent({ machineList, spacesList, execImpl: core.exec });
  const st = kent.machineStore(machine);
  const ops = [
    { type: 'create', id: 'g1', name: 'One' },
    { type: 'create', id: 'g2', name: 'Two' },
    { type: 'create', id: 'g3', name: 'Three' },
    { type: 'assign', space: 'sp1', targetGroup: 'g1' },
    { type: 'assign', space: 'sp2', targetGroup: 'g1' },
    { type: 'assign', space: 'sp3', targetGroup: 'g1' },
    { type: 'move', id: 'g1', anchor: 'g2', afterAnchor: true },
    { type: 'assign', space: 'sp1', targetGroup: 'g1', targetId: 'sp3', after: true },
  ];
  for (const intent of ops) kent.enqueueGroupOp(machine, intent, { label: intent.type });
  while (st.queue.length) await kent.processGroupOp(st, st.queue.shift());
  const doc = core.getDoc(machine);
  assert.deepEqual(doc.value.groups.map((g) => g.id), ['g2', 'g1', 'g3']);
  assert.deepEqual(doc.value.in.g1, ['sp2', 'sp3', 'sp1']);
  const view = kent.readStore();
  assert.deepEqual(view.in.g1, ['4090/sp2', '4090/sp3', '4090/sp1']);
}

async function testPruneAndPendingRestore() {
  const core = fakeCore();
  const storage = {};
  const sharedData = {};
  const machineList = [];
  const spacesList = [{ id: 'sp-live', machine: null }];
  const first = loadKent({ sharedData, storage, machineList, spacesList, execImpl: core.exec });
  first.kent.enqueueGroupOp(null, { type: 'create', id: 'g1', name: 'One', space: 'sp-dead' }, { label: 'create' });
  assert.ok(JSON.stringify(sharedData[PENDING_KEY]).includes('g1'), 'operation persisted');
  const st = first.kent.machineStore(null);
  await first.kent.processGroupOp(st, st.queue.shift());
  assert.ok(!JSON.stringify(sharedData[PENDING_KEY] ?? {}).includes('g1'), 'successful operation cleared');
  const doc = core.getDoc(null);
  assert.deepEqual(doc.value.in.g1, [], 'dead space pruned when machine is ready');

  first.kent.enqueueGroupOp(null, { type: 'rename', id: 'g1', name: 'Renamed' }, { label: 'rename' });
  assert.ok(JSON.stringify(sharedData[PENDING_KEY]).includes('rename'), 'offline operation persisted');
  const second = loadKent({ sharedData, storage, machineList, spacesList, execImpl: core.exec });
  const restored = second.kent.machineStore(null);
  assert.equal(restored.queue.length, 1, 'pending operation restored');
  assert.equal(restored.data.groups.find((g) => g.id === 'g1')?.name, 'Renamed', 'restored operation is optimistic');
  await second.kent.processGroupOp(restored, restored.queue.shift());
  assert.equal(core.getDoc(null).value.groups.find((g) => g.id === 'g1')?.name, 'Renamed', 'restored operation replays');
}

async function testReplayedSuccessfulOperationIsIdempotent() {
  const core = fakeCore();
  const machineList = [];
  const spacesList = [{ id: 'sp1', machine: null }];
  const { kent } = loadKent({ machineList, spacesList, execImpl: core.exec });
  const st = kent.machineStore(null);
  const intent = { type: 'create', id: 'g1', name: 'One', space: 'sp1' };
  kent.enqueueGroupOp(null, intent, { label: 'create', id: 'fixed-op' });
  await kent.processGroupOp(st, st.queue.shift());
  const version = core.getDoc(null).version;
  kent.enqueueGroupOp(null, intent, { label: 'create', id: 'fixed-op' });
  await kent.processGroupOp(st, st.queue.shift());
  assert.equal(core.getDoc(null).version, version, 'exact replay does not rewrite or duplicate');
  assert.deepEqual(core.getDoc(null).value.in.g1, ['sp1']);
}


async function testRemoteAdoptionKeepsOptimisticQueue() {
  const core = fakeCore();
  const machineList = [];
  const spacesList = [{ id: 'sp1', machine: null }];
  const { kent } = loadKent({ machineList, spacesList, execImpl: core.exec });
  const st = kent.machineStore(null);
  kent.enqueueGroupOp(null, { type: 'create', id: 'localg', name: 'Local', space: 'sp1' }, { label: 'create' });
  const remoteValue = kent.normalizeMachineData({
    groups: [{ id: 'remoteg', name: 'Remote', folded: false }],
    in: { remoteg: [] },
    defaultFolded: false,
    at: 1,
  }, null);
  const remoteDoc = core.getDoc(null);
  remoteDoc.value = remoteValue;
  remoteDoc.version = 1;
  kent.adoptRemote(st, remoteValue, 1);
  assert.deepEqual(st.data.groups.map((g) => g.id), ['remoteg', 'localg'], 'remote adoption rebuilds queued optimistic operations');
  assert.deepEqual(st.data.in.localg, ['sp1']);
  await kent.processGroupOp(st, st.queue.shift());
  assert.deepEqual(core.getDoc(null).value.groups.map((g) => g.id), ['remoteg', 'localg']);
}


async function testCoreResetRepair() {
  const core = fakeCore();
  const machineList = [];
  const spacesList = [{ id: 'sp1', machine: null }];
  const { kent, sharedData } = loadKent({ machineList, spacesList, execImpl: core.exec });
  const st = kent.machineStore(null);
  kent.enqueueGroupOp(null, { type: 'create', id: 'g1', name: 'One', space: 'sp1' }, { label: 'create' });
  await kent.processGroupOp(st, st.queue.shift());
  assert.equal(core.getDoc(null).version, 1);

  const doc = core.getDoc(null);
  doc.value = null;
  doc.version = 0;
  kent.adoptRemote(st, kent.normalizeMachineData(null, null), 0);
  assert.equal(st.queue.length, 0, 'one out-of-order regression is ignored');
  st.regressionSince = Date.now() - 20000;
  kent.adoptRemote(st, kent.normalizeMachineData(null, null), 0);
  assert.equal(st.queue[0]?.migration, true, 'sustained regression queues a repair migration');
  assert.equal(Boolean(sharedData[MIGRATED_KEY]?.['']), false, 'repair resets the migration marker');
  await kent.processGroupOp(st, st.queue.shift());
  assert.deepEqual(core.getDoc(null).value.in.g1, ['sp1'], 'repair restores grouped membership');
  assert.equal(core.getDoc(null).value.groups[0]?.name, 'One');
  assert.equal(Boolean(sharedData[MIGRATED_KEY]?.['']), true, 'successful repair marks migration done');
}


async function testCoreResetDetectedAfterRestart() {
  const core = fakeCore();
  const machineList = [];
  const spacesList = [{ id: 'sp1', machine: null }];
  const sharedData = {
    [STORE]: {
      groups: [{ id: 'g1', name: 'One', machine: null, folded: false }],
      in: { g1: ['sp1'] },
      defaultFolded: {},
    },
    [MIGRATED_KEY]: { '': 1 },
    [VERSIONS_KEY]: { '': 5 },
  };
  const { kent } = loadKent({ sharedData, machineList, spacesList, execImpl: core.exec });
  const st = kent.machineStore(null);
  assert.equal(st.queue.length, 0, 'remembered migration is not repeated normally');
  const resetValue = { groups: [], in: {}, defaultFolded: false, at: 1 };
  const doc = core.getDoc(null);
  doc.value = resetValue;
  doc.version = 1;
  kent.adoptRemote(st, kent.normalizeMachineData(resetValue, null), 1);
  assert.equal(st.queue.length, 0, 'first low version only starts reset detection');
  st.regressionSince = Date.now() - 20000;
  kent.adoptRemote(st, kent.normalizeMachineData(resetValue, null), 1);
  assert.equal(st.queue[0]?.migration, true, 'restart-persisted version detects the reset');
  await kent.processGroupOp(st, st.queue.shift());
  assert.deepEqual(core.getDoc(null).value.in.g1, ['sp1']);
  assert.equal(sharedData[VERSIONS_KEY]?.[''], 2, 'new incarnation version replaces the old baseline');
}


async function testMutationQueuesBehindCoreResetRepair() {
  const core = fakeCore();
  const machineList = [];
  const spacesList = [{ id: 'sp1', machine: null }];
  const { kent } = loadKent({ machineList, spacesList, execImpl: core.exec });
  const st = kent.machineStore(null);
  kent.enqueueGroupOp(null, { type: 'create', id: 'g1', name: 'One', space: 'sp1' }, { label: 'create' });
  await kent.processGroupOp(st, st.queue.shift());
  const doc = core.getDoc(null);
  doc.value = null;
  doc.version = 0;

  kent.enqueueGroupOp(null, { type: 'fold', id: 'g1', folded: true }, { label: 'fold' });
  const fold = st.queue.shift();
  await kent.processGroupOp(st, fold);
  assert.equal(core.getDoc(null).version, 0, 'mutation is not written onto the reset document before repair');
  assert.equal(st.queue[0]?.migration, true, 'repair is first');
  assert.equal(st.queue[1]?.intent?.type, 'fold', 'the interrupted mutation is requeued behind repair');
  while (st.queue.length) await kent.processGroupOp(st, st.queue.shift());
  assert.equal(core.getDoc(null).value.groups.find((g) => g.id === 'g1')?.folded, true);
  assert.deepEqual(core.getDoc(null).value.in.g1, ['sp1']);
}

async function testPruneWaitsForReadyMachine() {
  const core = fakeCore();
  const machineList = [{ name: null, layout: 'unavailable' }];
  const { kent } = loadKent({ machineList, spacesList: [], execImpl: core.exec });
  kent.enqueueGroupOp(null, { type: 'create', id: 'g1', name: 'One', space: 'sp-dead' }, { label: 'create' });
  const st = kent.machineStore(null);
  await kent.processGroupOp(st, st.queue.shift());
  assert.deepEqual(core.getDoc(null).value.in.g1, ['sp-dead'], 'unavailable machine keeps membership');
}

async function testPruneThisComputerWithoutMachinesEntry() {
  // In a real app `machines()` never lists this computer, so its spaces come
  // straight from the running app and no layout entry has to be waited for.
  const core = fakeCore();
  const spacesList = [{ id: 'sp-live', machine: null }];
  const { kent } = loadKent({ machineList: [], spacesList, execImpl: core.exec });
  const local = { groups: [{ id: 'g1', name: 'One', machine: null, folded: false }], in: { g1: ['sp-dead', 'sp-live'] }, defaultFolded: false };
  assert.equal(kent.pruneMachineData(local, null), true, 'this computer prunes without a machines() entry');
  assert.deepEqual(local.in.g1, ['sp-live']);

  const remote = { groups: [{ id: 'g2', name: 'Two', machine: '4090', folded: false }], in: { g2: ['sp-x', 'sp-dead'] }, defaultFolded: false };
  const remoteSpaces = [{ id: '4090/sp-x', machine: '4090' }];
  assert.equal(kent.pruneMachineData(remote, '4090', remoteSpaces, [{ name: '4090', layout: 'unavailable' }]), false, 'a machine still loading keeps its members');
  assert.deepEqual(remote.in.g2, ['sp-x', 'sp-dead']);
}


async function testUnsupportedCoreIsDetected() {
  const core = fakeCore({ fail: () => ({ kind: 'needs_update', message: 'core does not support documents' }) });
  const { kent } = loadKent({ execImpl: core.exec });
  await assert.rejects(() => kent.docGet(null), (e) => {
    assert.equal(e.unsupported, true);
    return true;
  });
}

async function testMachineIsolation() {
  const core = fakeCore();
  const machineList = [{ name: '4090', layout: 'ready' }];
  const spacesList = [{ id: 'sp1', machine: null }, { id: '4090/sp1', machine: '4090' }];
  const { kent, sharedData } = loadKent({ machineList, spacesList, execImpl: core.exec });
  for (const machine of [null, '4090']) {
    kent.enqueueGroupOp(machine, { type: 'create', id: `g-${machine ?? 'local'}`, name: 'One', space: 'sp1' }, { label: 'create' });
    const st = kent.machineStore(machine);
    await kent.processGroupOp(st, st.queue.shift());
  }
  assert.deepEqual(core.getDoc(null).value.in['g-local'], ['sp1']);
  assert.deepEqual(core.getDoc('4090').value.in['g-4090'], ['sp1']);
  const view = kent.readStore();
  assert.deepEqual(view.in['g-local'], ['sp1']);
  assert.deepEqual(view.in['g-4090'], ['4090/sp1']);
  assert.equal(sharedData[STORE].groups.find((g) => g.id === 'g-4090')?.machine, '4090', 'compatibility snapshot keeps machine scope');
  assert.deepEqual(sharedData[STORE].in['g-4090'], ['4090/sp1'], 'compatibility snapshot uses client-facing ids');
}

async function testFoldRenameDeleteIntents() {
  const core = fakeCore();
  const machineList = [];
  const { kent } = loadKent({ machineList, spacesList: [], execImpl: core.exec });
  const st = kent.machineStore(null);
  const ops = [
    { type: 'create', id: 'g1', name: 'One' },
    { type: 'rename', id: 'g1', name: 'Renamed' },
    { type: 'fold', id: 'g1', folded: true },
    { type: 'fold', defaultGroup: true, folded: true },
    { type: 'delete', id: 'g1' },
  ];
  for (const intent of ops) kent.enqueueGroupOp(null, intent, { label: intent.type });
  while (st.queue.length) await kent.processGroupOp(st, st.queue.shift());
  const doc = core.getDoc(null).value;
  assert.deepEqual(doc.groups, []);
  assert.equal(doc.defaultFolded, true);
  assert.deepEqual(doc.in, {});
}

function testSyncWorkerAdoption() {
  const { kent } = loadKent();
  const makeCx = () => ({
    spawn: () => ({}),
    timer: { every: () => ({}) },
    notify: () => {},
  });
  const first = makeCx();
  const second = makeCx();
  kent.startGroupSync(first);
  const generation = kent.groupSync.generation;
  assert.equal(kent.groupSync.started, true);
  kent.startGroupSync(second);
  assert.equal(kent.groupSync.generation, generation, 'a live owner keeps the shared worker');
  kent.groupSync.heartbeat = 0;
  kent.startGroupSync(second);
  assert.ok(kent.groupSync.generation > generation, 'a surviving copy adopts a stale worker');
  kent.stopGroupSync();
  assert.equal(kent.groupSync.started, false);
}

async function testUnavailableStaysQueued() {
  const core = fakeCore({ fail: () => ({ kind: 'machine_unknown' }) });
  const { kent, sharedData } = loadKent({ execImpl: core.exec });
  const st = kent.machineStore('missing');
  kent.enqueueGroupOp('missing', { type: 'create', id: 'g1', name: 'One' }, { label: 'create' });
  assert.equal(st.queue.length, 1);
  await assert.rejects(() => kent.processGroupOp(st, st.queue[0]), /machine_unknown/);
  assert.ok(sharedData[PENDING_KEY], 'operation remains persisted for retry');
}

function isolatedCoreEnv() {
  const tmp = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'kt-'));
  for (const dir of ['home', 'state', 'config', 'runtime']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  fs.chmodSync(path.join(tmp, 'runtime'), 0o700);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('HC_') || key.startsWith('HERDR_')) delete env[key];
  Object.assign(env, {
    HOME: path.join(tmp, 'home'),
    XDG_STATE_HOME: path.join(tmp, 'state'),
    XDG_CONFIG_HOME: path.join(tmp, 'config'),
    XDG_RUNTIME_DIR: path.join(tmp, 'runtime'),
    HC_SESSION: `kt${process.pid.toString(36)}`,
  });
  return { tmp, env };
}

function processExec(env) {
  return (cmd, args, options = {}) => new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, {
      env,
      timeout: options.timeout ?? 15000,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && error.killed) reject(error);
      else resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function testRealCoreRpc() {
  const { tmp, env } = isolatedCoreEnv();
  try {
    const { kent } = loadKent({ execImpl: processExec(env) });
    const value = {
      groups: [{ id: 'g1', name: '代码 🖥️', folded: false }],
      in: { g1: ['sp1', 'sp2'] },
      defaultFolded: true,
      at: 1,
    };
    const initial = await kent.docGet(null);
    assert.equal(initial.version, 0);
    assert.equal(initial.value, null);
    const written = await kent.docSet(null, value, 0);
    assert.equal(written.version, 1);
    const got = await kent.docGet(null);
    assert.deepEqual(got.value, value);
    await assert.rejects(() => kent.docSet(null, { bad: true }, 0), /version 1|conflict/i);
    console.log('isolated real-core document RPC/CAS integration passed');
  } finally {
    try { childProcess.execFileSync('hc', ['server', 'stop'], { env, encoding: 'utf8', timeout: 10000 }); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testFilterAndParkedStore() {
  const { kent } = loadKent();
  const methods = kent.Spaces.prototype;
  const ctx = {
    filtering: true,
    filterText: ' code ',
    filterActive: methods.filterActive,
    rowMatches: methods.rowMatches,
    groupMatches: methods.groupMatches,
    projectMatches: methods.projectMatches,
  };
  assert.equal(ctx.filterActive(), true);
  assert.equal(ctx.rowMatches({ w: { name: 'Code editor', machine: null }, g: { repo: 'kent', branch: 'main' } }), true);
  assert.equal(ctx.rowMatches({ w: { name: 'Scratch', machine: null }, g: { repo: 'notes', branch: 'dev' } }), false);
  assert.equal(ctx.rowMatches({ w: { name: 'Remote', machine: '4090' }, g: null }), false);
  assert.equal(ctx.groupMatches({ name: 'Code tools' }), true);
  assert.equal(ctx.groupMatches({ name: 'Design' }), false);

  kent.rememberProject({ machine: 'm', folder: '/tmp/one/', name: 'One', named: true, group: 'g' });
  kent.rememberProject({ machine: 'm', folder: '/tmp/one', name: 'One again', named: true, group: 'g2' });
  const entries = kent.projectEntries('m');
  assert.equal(entries.length, 1, 'trailing slash is the same folder');
  assert.equal(entries[0].name, 'One again');
  assert.equal(entries[0].group, 'g2');
  assert.equal(kent.forgetProject('m', '/tmp/one/'), true);
  assert.equal(kent.projectEntries('m').length, 0);

  for (let i = 0; i < 55; i += 1) kent.rememberProject({ machine: null, folder: `/tmp/p${i}`, name: `p${i}` });
  assert.equal(kent.projectEntries(null).length, 50, 'the drawer is capped');

  assert.equal(kent.projectKeyOf('m', '/tmp/one/'), kent.projectKeyOf('m', '/tmp/one'));
  assert.equal(kent.normPath('/tmp/one//'), '/tmp/one');
}

function testAgentAndParkedMachines() {
  const agentsList = [
    { address: 'om36/t1', status: 'idle', space_name: 'deliver' },
    { address: 'om36/t2', status: 'blocked', space_name: 'deliver-ai-2' },
    { address: 't3', status: 'idle', space_name: 'local' },
  ];
  const { kent } = loadKent({
    machineList: [{ name: '4090', layout: 'ready' }],
    spacesList: [{ id: 'sp1', machine: null }, { id: '4090/sp1', machine: '4090' }],
    agentsList,
  });
  assert.equal(kent.agentMachine('om36/t1'), 'om36');
  assert.equal(kent.agentMachine('t3'), null);
  assert.equal(kent.agentsOnMachine('om36', agentsList).length, 2);
  assert.equal(kent.firstAgentOnMachine('om36', agentsList).address, 'om36/t2');
  const names = kent.syncMachineNames();
  assert.deepEqual(names.filter(Boolean).sort(), ['4090', 'om36']);
  assert.ok(names.includes(null));

  kent.rememberProject({ machine: 'parked-box', folder: '/tmp/p', name: 'P' });
  assert.ok(kent.syncMachineNames().includes('parked-box'));

  kent.rememberTemporaryMachines([{ name: 'om36', temporary: true }, { name: '4090', temporary: false }]);
  assert.equal(kent.isTemporaryMachine('om36'), true);
  const after = kent.syncMachineNames();
  assert.ok(!after.includes('om36'), 'temporary agent machines stay hidden');
  assert.ok(after.includes('4090'));
  assert.ok(after.includes('parked-box'));
  kent.rememberTemporaryMachines([]);
}

function testParseGroupDocEvents() {
  const { kent } = loadKent();
  const doc = kent.parseGroupDocEvent(JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: { type: 'doc', data: { name: 'kent.groups.v1', version: 2 }, machine: 'om36', seq: 43 },
  }));
  assert.deepEqual(doc, { type: 'doc', name: 'kent.groups.v1', version: 2, machine: 'om36', seq: 43 });

  const local = kent.parseGroupDocEvent(JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: { type: 'doc', data: { name: 'kent.groups.v1', version: 1 }, seq: 8 },
  }));
  assert.equal(local.type, 'doc');
  assert.equal(local.machine, null);

  const missed = kent.parseGroupDocEvent(JSON.stringify({
    jsonrpc: '2.0',
    method: 'missed',
    params: { seq: 57, terminals: [] },
  }));
  assert.equal(missed.type, 'missed');
  assert.equal(kent.parseGroupDocEvent(JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 9 } })), null);
  assert.equal(kent.parseGroupDocEvent('{"seq":1,"terminals":[]}'), null);
  assert.equal(kent.eventsLookUnsupported(1, "error: unexpected argument '--doc' found", ''), true);
  assert.equal(kent.eventsLookUnsupported(0, '', ''), false);
  assert.equal(kent.eventsLookUnsupported(1, 'machine unknown', ''), false);
}

async function testRefreshQueuedWhenEventArrivesDuringPoll() {
  const core = fakeCore();
  const doc = core.getDoc('4090');
  doc.value = { groups: [], in: {}, defaultFolded: false, at: 1 };
  doc.version = 1;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let hold = true;
  const exec = async (cmd, args) => {
    const result = await core.exec(cmd, args);
    if (hold) {
      hold = false;
      await gate;
    }
    return result;
  };
  const { kent } = loadKent({
    machineList: [{ name: '4090', layout: 'ready' }],
    execImpl: exec,
  });
  const tasks = [];
  const cx = {
    spawn(fn) { const p = fn(cx); tasks.push(p); return p; },
    notify() {},
  };
  kent.machineStore('4090');
  kent.refreshGroupDocs(cx, { hiddenOk: true });
  assert.equal(kent.groupSync.polling, true, 'poll is in flight');
  // The document changes while the first doc.get waits; the event asks for a refresh.
  doc.value = { groups: [{ id: 'g', name: 'Remote', folded: false }], in: { g: [] }, defaultFolded: false, at: 2 };
  doc.version = 2;
  kent.refreshGroupDocs(cx, { hiddenOk: true });
  assert.equal(kent.groupSync.refreshPending, true, 'the event refresh is queued');
  release();
  while (tasks.length) await tasks.shift();
  const st = kent.machineStore('4090');
  assert.equal(st.version, 2, 'the queued refresh reads the newer document');
  assert.equal(st.data.groups.length, 1);
  assert.equal(kent.groupSync.refreshPending, false);
}

async function testWaitGroupDocEventStopsProducer() {
  if (process.platform === 'win32') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kent-hc-'));
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const mock = path.join(bin, 'hc');
    fs.writeFileSync(mock, [
      '#!/bin/sh',
      'if [ "$1" = "events" ]; then',
      `  printf '%s\\n' '{"jsonrpc":"2.0","method":"snapshot","params":{"seq":0}}'`,
      `  printf '%s\\n' '{"jsonrpc":"2.0","method":"event","params":{"type":"doc","data":{"name":"kent.groups.v1","version":7},"seq":1}}'`,
      '  sleep 8',
      `  printf '%s\\n' '{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":2}}'`,
      'fi',
      '',
    ].join('\n'));
    fs.chmodSync(mock, 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const { kent } = loadKent({ execImpl: processExec(env) });
    const started = Date.now();
    const ev = await kent.waitGroupDocEvent();
    const elapsed = Date.now() - started;
    assert.equal(ev.type, 'doc');
    assert.equal(ev.version, 7);
    assert.ok(elapsed < 4000, `waiter returned after ${elapsed}ms; it must stop the producer once the line arrives`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  await testCanonical();
  await testUnicodeRpc();
  await testWindowsRpcPayloadShape();
  await testMigration();
  await testLegacyAliasMigration();
  await testMigrationMergesByNameAndRemoteWins();
  await testCreateConflictAndIdentity();
  await testMoveAndAssignAreCanonical();
  await testPruneAndPendingRestore();
  await testReplayedSuccessfulOperationIsIdempotent();
  await testRemoteAdoptionKeepsOptimisticQueue();
  await testCoreResetRepair();
  await testCoreResetDetectedAfterRestart();
  await testMutationQueuesBehindCoreResetRepair();
  await testPruneWaitsForReadyMachine();
  await testPruneThisComputerWithoutMachinesEntry();
  await testUnsupportedCoreIsDetected();
  await testMachineIsolation();
  testSyncWorkerAdoption();
  testFilterAndParkedStore();
  testAgentAndParkedMachines();
  testParseGroupDocEvents();
  await testWaitGroupDocEventStopsProducer();
  await testRefreshQueuedWhenEventArrivesDuringPoll();
  await testFoldRenameDeleteIntents();
  await testUnavailableStaysQueued();
  console.log('group sync harness checks passed');
  if (process.argv.includes('--core')) await testRealCoreRpc();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
