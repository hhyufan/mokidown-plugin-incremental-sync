import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { migrateLegacyState, openLegacyStorage } from '../src/legacy.mjs';
import { cloudSyncPlugin } from '../src/plugins/cloud-sync.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
function legacy(count=60) {
 const files={};
 for(let i=1;i<=count;i++)files[`file-${i}`]={content:'hello',compressed:false,size:5,checksum:hash('hello'),fileName:`note-${i}.md`,encoding:'UTF-8',lineEnding:'LF',baseRev:0,mutationId:`mutation-${i}`,fileId:`file-${i}`,rev:i,updatedAt:1234};
 return {rev:count,files};
}
test('imports legacy data once, preserves originals, and paginates without skipping files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'moki-legacy-'));let storage;
 try{
  const original=JSON.stringify(legacy());await writeFile(join(dir,'documents.json'),original);
  storage=await openLegacyStorage(dir);
  assert.equal(await readFile(join(dir,'documents.json'),'utf8'),original);
  assert.equal((await readdir(dir)).filter(name=>name.startsWith('documents.pre-v3-')).length,1);
  const ids=[];let cursor='';let more=true;
  while(more){const page=await cloudSyncPlugin.handle({method:'GET',path:'/sync/changes',query:new URLSearchParams({cursor,limit:'25'}),namespace:'default',storage});ids.push(...page.changes.map(file=>file.fileId));cursor=page.nextCursor;more=page.hasMore;}
  assert.equal(new Set(ids).size,60);assert.equal(cursor,'60');
  const record=legacy().files['file-60'];const {fileId:_id,rev:_rev,updatedAt:_time,...body}=record;
  const replay=await cloudSyncPlugin.handle({method:'PUT',path:'/sync/file/file-60',body,namespace:'default',storage});
  assert.equal(replay.rev,60);assert.equal((await storage.get('sync:default')).seq,60);
  await storage.close();storage=null;
  await writeFile(join(dir,'documents.json'),JSON.stringify(legacy(1)));
  storage=await openLegacyStorage(dir);assert.equal(Object.keys((await storage.get('sync:default')).files).length,60);
 }finally{await storage?.close();await rm(dir,{recursive:true,force:true});}
});
test('rejects damaged legacy content instead of importing it silently',()=>{
 const data=legacy(1);data.files['file-1'].content='corrupted';assert.throws(()=>migrateLegacyState(data),/checksum or size/);
});
