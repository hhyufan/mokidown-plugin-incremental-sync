import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
const execute=promisify(execFile);
const freePort=async()=>{const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;};
for(const standalone of [false,true])test(`detached ${standalone?'single-file':'npm'} service persists history, rejects conflicts and stops its children`,{timeout:30000},async()=>{
 const home=await mkdtemp(join(tmpdir(),'mokidown-daemon-test-'));
 const root=resolve(import.meta.dirname,'../../..');
 let entry=join(root,'bin/cli.mjs');
 if(standalone){entry=join(home,'standalone.mjs');await copyFile(join(root,'standalone.mjs'),entry);}
 const env={...process.env,MOKIDOWN_SYNC_HOME:home};
 const run=(...args)=>execute(process.execPath,[entry,...args],{env,timeout:20000,windowsHide:true});
 const port=await freePort(),proxy=await freePort(),token='test-'+randomUUID();
 try{
  await run('start','--no-tunnel','--port',String(port),'--proxy-port',String(proxy),'--token',token);
  const state=(await run('status')).stdout;assert.match(state,/running/);
  const again=(await run('start','--no-tunnel')).stdout;assert.equal(again.match(/PID (\d+)/)?.[1],state.match(/PID (\d+)/)?.[1]);
  const req=async(path,method='GET',body)=>{const res=await fetch(`http://127.0.0.1:${proxy}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
  const snapshot=(content,rev)=>({content,compressed:false,size:Buffer.byteLength(content),checksum:createHash('sha256').update(content).digest('hex'),fileName:'notes.md',baseRev:rev,mutationId:randomUUID()});
  const first=snapshot('one',0);assert.equal((await req('/sync/file/doc','PUT',first)).status,200);
  assert.equal((await req('/sync/file/doc','PUT',snapshot('two',1))).data.rev,2);
  assert.equal((await req('/sync/file/doc','PUT',snapshot('stale',1))).status,409);
  assert.equal((await req('/sync/file/other-id','PUT',snapshot('collision',0))).data.code,'PATH_CONFLICT');
  assert.equal((await req('/sync/file/doc','PUT',first)).data.rev,1);
  assert.deepEqual((await req('/sync/file/doc/versions')).data.versions.map(v=>v.rev),[2,1]);
  assert.equal((await req('/sync/file/doc/versions/1')).data.content,'one');
  await run('stop');
  await assert.rejects(fetch(`http://127.0.0.1:${proxy}/capabilities`));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/capabilities`));
  await run('start','--no-tunnel','--port',String(port),'--proxy-port',String(proxy),'--token',token);
  assert.deepEqual((await req('/sync/file/doc/versions')).data.versions.map(v=>v.rev),[2,1]);
  assert.equal((await req('/sync/file/doc/versions/2')).data.content,'two');
  await run('stop');await assert.rejects(run('status'),error=>error.code===3);
 }finally{await run('stop').catch(()=>{});await rm(home,{recursive:true,force:true});}
});
