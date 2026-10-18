import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalSync, sha256, validPath, decodeDocument } from '../src/engine.mjs';
import { cloudSyncPlugin } from '../../services/sync-server/src/plugins/cloud-sync.mjs';
import { openStorage } from '../../services/sync-server/src/storage.mjs';

async function fixture() {
  const storage = await openStorage({ type: 'sqlite', filename: ':memory:' });
  function device(workspaceId, initial = {}) {
    const disk = new Map(Object.entries(initial)); const saved = new Map(); const calls = [];
    const report = [];
    const rpc = async (method, args = {}) => {
      calls.push({ rpc: method, ...structuredClone(args) });
      if (method === 'context') return { endpoint: 'https://self.test', workspace: true, workspaceId };
      if (method === 'storage.get') return structuredClone(saved.get(args.key));
      if (method === 'storage.set') { saved.set(args.key, structuredClone(args.value)); return true; }
      if (method === 'fs.read') { const content = disk.get(args.path) ?? null; return { content, checksum: content === null ? null : await sha256(content) }; }
      if (method === 'fs.list') {
        const prefix = args.path ? `${args.path}/` : ''; const entries = new Map();
        for (const path of disk.keys()) if (path.startsWith(prefix)) {
          const remainder = path.slice(prefix.length); const name = remainder.split('/')[0];
          entries.set(name, { name, directory: remainder.includes('/') });
        }
        return [...entries.values()];
      }
      if (method === 'fs.write' || method === 'fs.delete') {
        const current = disk.get(args.path) ?? null;
        assert.equal(current === null ? null : await sha256(current), args.expectedHash);
        if (method === 'fs.write') disk.set(args.path, args.content); else disk.delete(args.path);
        return true;
      }
      if (method === 'net.request') {
        if (args.path === '/capabilities') return { status: 200, data: { service: 'mokidown-plugin-server', instanceId: 'service-one', namespace: 'default', plugins: [{ id: 'cloud-sync', protocolVersion: 3 }] } };
        const url = new URL(args.path, 'https://self.test');
        try { return { status: 200, data: await cloudSyncPlugin.handle({ method: args.method, path: url.pathname, query: url.searchParams, body: args.body, namespace: 'default', storage }) }; }
        catch (error) { if (!error.status) throw error; return { status: error.status, data: { code: error.code, message: error.message, ...error.details } }; }
      }
      throw new Error(`Unexpected method ${method}`);
    };
    const create = (transport = rpc) => new IncrementalSync(transport, (value) => report.push(value));
    return { disk, saved, calls, rpc, create, report };
  }
  return { storage, device };
}

test('uploads only changed files, pulls to a second device, and handles nested paths', async () => {
  const f = await fixture();
  try {
    const a = f.device('a', { 'nested/a.md': 'one', 'b.txt': 'two', 'ignored.js': 'code' });
    const engine = a.create(); await engine.cycle();
    let state = await f.storage.get('sync:default'); assert.equal(Object.keys(state.files).length, 2);
    const puts = () => a.calls.filter((call) => call.rpc === 'net.request' && call.method === 'PUT').length;
    const initialPuts = puts(); await engine.cycle(); assert.equal(puts(), initialPuts);
    const b = f.device('b'); const second = b.create(); await second.cycle();
    assert.equal(b.disk.get('nested/a.md'), 'one'); assert.equal(b.disk.get('b.txt'), 'two');
    a.disk.set('nested/a.md', 'new'); await engine.cycle(); await second.cycle();
    assert.equal(b.disk.get('nested/a.md'), 'new');
    state = await f.storage.get('sync:default'); assert.equal(state.seq, 3);
  } finally { await f.storage.close(); }
});

test('retains divergent local text until the user chooses a conflict resolution', async () => {
  const f = await fixture();
  try {
    const a = f.device('a', { 'a.md': 'base' }); const ea = a.create(); await ea.cycle();
    const b = f.device('b'); const eb = b.create(); await eb.cycle();
    a.disk.set('a.md', 'remote edit'); b.disk.set('a.md', 'local edit');
    await ea.cycle(); await eb.cycle();
    assert.equal(b.disk.get('a.md'), 'local edit');
    const conflictId = Object.keys(eb.state.conflicts)[0]; assert.ok(conflictId);
    await eb.resolve(conflictId, 'local'); await ea.cycle();
    assert.equal(a.disk.get('a.md'), 'local edit'); assert.deepEqual(eb.state.conflicts, {});
  } finally { await f.storage.close(); }
});

test('persists and replays a dropped acknowledgement with the same mutation ID', async () => {
  const f = await fixture();
  try {
    const a = f.device('a', { 'a.md': 'once' }); let dropped = false;
    const ea = a.create(async (method, args) => {
      const result = await a.rpc(method, args);
      if (!dropped && method === 'net.request' && args.method === 'PUT') { dropped = true; throw new Error('Acknowledgement lost'); }
      return result;
    });
    await ea.cycle(); assert.ok(ea.state.pending);
    const restarted = a.create(); await restarted.cycle();
    const state = await f.storage.get('sync:default'); assert.equal(state.seq, 1);
    assert.equal(Object.values(state.files)[0].rev, 1); assert.equal(restarted.state.pending, null);
  } finally { await f.storage.close(); }
});

test('propagates deletions and ignores unknown old tombstones on a new device', async () => {
  const f = await fixture();
  try {
    const a = f.device('a', { 'a.md': 'delete me' }); const ea = a.create(); await ea.cycle();
    const b = f.device('b'); const eb = b.create(); await eb.cycle();
    a.disk.delete('a.md'); await ea.cycle(); await eb.cycle(); assert.equal(b.disk.size, 0);
    const c = f.device('c'); const ec = c.create(); await ec.cycle();
    assert.equal(c.report.at(-1).error, undefined); assert.equal(c.disk.size, 0);
  } finally { await f.storage.close(); }
});

test('a failed scan never propagates deletions', async () => {
  const f = await fixture();
  try {
    const a = f.device('a', { 'a.md': 'keep' }); const ea = a.create(); await ea.cycle();
    a.disk.clear();
    const broken = a.create((method, args) => { if (method === 'fs.list') throw new Error('Disk unavailable'); return a.rpc(method, args); });
    await broken.cycle();
    assert.equal(Object.values((await f.storage.get('sync:default')).files)[0].deleted, false);
  } finally { await f.storage.close(); }
});

test('stopping during a pull cannot write files after the service reply arrives', async () => {
  const f = await fixture();
  try {
    const a = f.device('a', { 'a.md': 'remote' }); await a.create().cycle();
    const b = f.device('b'); let resolveReply; let reached;
    const waiting = new Promise((resolve) => { reached = resolve; });
    const eb = b.create(async (method, args) => {
      const result = await b.rpc(method, args);
      if (method === 'net.request' && args.path.startsWith('/sync/file/')) {
        reached(); await new Promise((resolve) => { resolveReply = resolve; });
      }
      return result;
    });
    const work = eb.cycle(); await waiting; eb.stop(); resolveReply(); await work;
    assert.equal(b.disk.size, 0);
  } finally { await f.storage.close(); }
});

test('rejects traversal and corrupted text before it can reach local files', async () => {
  for (const path of ['../a.md', '/a.md', 'x/../../a.md', 'C:/a.md', 'x\\a.md', '.hidden/a.md']) assert.equal(validPath(path), false);
  await assert.rejects(() => decodeDocument({ content: 'wrong', size: 5, compressed: false, checksum: 'bad' }), /checksum/);
});
test('switching local and remote endpoints retains service state and file identities', async () => {
  const f=await fixture();
  try {
    const a=f.device('same-workspace',{'a.md':'hello'});
    await a.create().cycle();
    const initialPuts=a.calls.filter(call=>call.rpc==='net.request' && call.method==='PUT').length;
    const second=a.create(async(method,args)=>method==='context'?{endpoint:'http://192.168.1.2:8787',workspace:true,workspaceId:'same-workspace'}:a.rpc(method,args));
    await second.cycle();
    assert.equal(a.calls.filter(call=>call.rpc==='net.request' && call.method==='PUT').length,initialPuts);
    assert.equal(Object.keys((await f.storage.get('sync:default')).files).length,1);
  } finally {await f.storage.close();}
});
test('preserves UTF-8 BOM documents byte-for-byte across devices',async()=>{
 const f=await fixture();
 try{
  const text='\ufeff# BOM document\n';const source=f.device('bom-source',{'bom.md':text});await source.create().cycle();
  const target=f.device('bom-target');const engine=target.create();await engine.cycle();
  assert.equal(target.disk.get('bom.md'),text);
  assert.equal(target.report.some(update=>update.error),false);
 }finally{await f.storage.close();}
});
test('rejects old cursor-only responses with a service upgrade diagnostic',async()=>{
 const f=await fixture();
 try{
  const target=f.device('legacy-page');const engine=target.create(async(method,args)=>method==='net.request'&&args.path.startsWith('/sync/changes')?{status:200,data:{changes:[],cursor:0}}:target.rpc(method,args));
  await engine.cycle();assert.match(target.report.at(-1).phase,/SYNC_PROTOCOL_MISMATCH/);assert.equal(target.report.at(-1).error,true);
 }finally{await f.storage.close();}
});
for (const choice of ['local','remote','merged'])test(`resolves ${choice} against the reviewed version and persists completion`,async()=>{
 const f=await fixture();try{
  const a=f.device('resolve-a',{'a.md':'base'});const ea=a.create();await ea.cycle();
  const b=f.device('resolve-b');const eb=b.create();await eb.cycle();
  a.disk.set('a.md','cloud');b.disk.set('a.md','local');await ea.cycle();await eb.cycle();
  const [id,conflict]=Object.entries(eb.state.conflicts)[0];
  b.disk.set('a.md','latest local');
  await eb.resolve(id,choice,{expectedHash:await sha256('latest local'),expectedRemoteRev:conflict.remoteRev,content:'merged result'});
  const expected=choice==='local'?'latest local':choice==='remote'?'cloud':'merged result';
  assert.equal(b.disk.get('a.md'),expected);
  assert.equal((await f.storage.get('sync:default')).files[id].content,expected);
  assert.equal(Object.keys(eb.state.conflicts).length,0);
  assert.equal(eb.state.resolutions['a.md'].rev,eb.state.files[id].rev);
  const restarted=b.create();await restarted.cycle();assert.ok(restarted.state.resolutions['a.md']);assert.equal(Object.keys(restarted.state.conflicts).length,0);
 }finally{await f.storage.close();}
});
test('failed writes never report completion, and acknowledged retry completes the same resolution',async()=>{
 const f=await fixture();try{
  const a=f.device('fail-a',{'a.md':'base'});const ea=a.create();await ea.cycle();const b=f.device('fail-b');
  let fail=false;const eb=b.create(async(method,args)=>fail&&method==='net.request'&&args.method==='PUT'?{status:503,data:{message:'offline'}}:b.rpc(method,args));await eb.cycle();
  a.disk.set('a.md','cloud');b.disk.set('a.md','local');await ea.cycle();await eb.cycle();const id=Object.keys(eb.state.conflicts)[0];
  fail=true;await assert.rejects(eb.resolve(id,'local'),/offline/);assert.ok(eb.state.conflicts[id]);assert.equal(eb.state.resolutions?.['a.md'],undefined);
  fail=false;await eb.cycle();assert.equal(Object.keys(eb.state.conflicts).length,0);assert.ok(eb.state.resolutions['a.md']);
 }finally{await f.storage.close();}
});
test('explicit resolution picks a legacy identity without deleting other remote records',async()=>{
 const f=await fixture();try{
  const b=f.device('duplicate-source',{'a.md':'base'});const engine=b.create();await engine.cycle();
  const original=Object.keys(engine.state.files)[0];
  await b.rpc('net.request',{method:'PUT',path:'/sync/file/duplicate-id',body:{content:'another remote',compressed:false,size:14,checksum:await sha256('another remote'),fileName:'a.md',baseRev:0,mutationId:crypto.randomUUID()}});
  await engine.cycle();assert.ok(engine.state.conflicts['duplicate-id']);
  await engine.resolve('duplicate-id','remote',{expectedHash:await sha256('base'),expectedRemoteRev:1});
  assert.equal(b.disk.get('a.md'),'another remote');assert.equal(engine.state.files[original].detached,true);
  await engine.cycle();assert.equal(Object.keys(engine.state.conflicts).length,0);
  assert.equal(Object.keys((await f.storage.get('sync:default')).files).length,2);
 }finally{await f.storage.close();}
});
