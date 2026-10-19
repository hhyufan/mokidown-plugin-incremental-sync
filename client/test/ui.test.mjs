import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {createHash,webcrypto} from 'node:crypto';
import {openStorage} from '../../services/sync-server/src/storage.mjs';
import {cloudSyncPlugin} from '../../services/sync-server/src/plugins/cloud-sync.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
const wait=async(check)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('Timed out waiting for plugin state');await new Promise(resolve=>setTimeout(resolve,10));}};
const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/main.mjs',import.meta.url))],bundle:true,format:'iife',write:false,alias:{'@mokidown/sdk':fileURLToPath(new URL('../../sdk/index.mjs',import.meta.url))}});
async function fixture(){
 const storage=await openStorage({type:'sqlite',filename:':memory:'});
 const disk=new Map([['a.md','initial a'],['b.md','initial b']]),saved=new Map(),statuses=new Map(),badges=new Map(),registered=new Set(),replies=new Map(),handlers=new Map();
 let networkFailure=false;
 let documents=[{id:'a',path:'/notes/a.md',name:'a.md',relativePath:'a.md',active:true},{id:'b',path:'/notes/b.md',name:'b.md',relativePath:'b.md',active:false}],comparison;
 const parent={postMessage(){}};const window={addEventListener:(name,callback)=>handlers.set(name,callback),removeEventListener:name=>handlers.delete(name)};
 const ports=new MessageChannel();
 const request=async(method,args={})=>{
  if(method==='context')return {endpoint:'http://fixture',workspace:true,workspaceId:'workspace'};
  if(method==='command.register'){registered.add(args.id);return true;}
  if(method==='editor.listDocuments')return documents;
  if(method==='editor.showDiff'){comparison=args;return true;}
  if(method==='editor.reloadDocument')return true;
  if(method==='storage.get')return saved.get(args.key);
  if(method==='storage.set'){saved.set(args.key,structuredClone(args.value));return true;}
  if(method==='statusBar.addItem'){statuses.set(args.id,args);return true;}
  if(method==='statusBar.remove'){statuses.delete(args.id);return true;}
  if(method==='fileBadge.add'){badges.set(args.id,args);return true;}
  if(method==='fileBadge.remove'){badges.delete(args.id);return true;}
  if(method==='versions.set'||method==='versions.remove'||method.startsWith('task.'))return true;
  if(method==='fs.list')return [...disk.keys()].map(name=>({name,directory:false}));
  if(method==='fs.read'){const content=disk.get(args.path)??null;return {content,checksum:content===null?null:hash(content)};}
  if(method==='fs.write'){assert.equal(hash(disk.get(args.path)),args.expectedHash);disk.set(args.path,args.content);return true;}
  if(method==='net.request'){
   if(networkFailure)return {status:503,data:{message:'Service unavailable'}};
   if(args.path==='/capabilities')return {status:200,data:{service:'mokidown-plugin-server',instanceId:'ui-fixture',namespace:'default',plugins:[{id:'cloud-sync',protocolVersion:3}]}};
   const url=new URL(args.path,'http://fixture');
   try{return {status:200,data:await cloudSyncPlugin.handle({method:args.method||'GET',path:url.pathname,query:url.searchParams,body:args.body,namespace:'default',storage})};}
   catch(error){return {status:error.status||500,data:{message:error.message,code:error.code,...error.details}};}
  }
  throw Error('Unexpected method '+method);
 };
 ports.port1.on('message',async message=>{
  if(message.type==='command-result'){const pending=replies.get(message.requestId);if(pending){replies.delete(message.requestId);message.error?pending.reject(new Error(message.error)):pending.resolve(message.value);}return;}
  try{ports.port1.postMessage({id:message.id,value:await request(message.method,message.args)});}catch(error){ports.port1.postMessage({id:message.id,error:error.message});}
 });
 runInNewContext(bundled.outputFiles[0].text,{window,parent,crypto:webcrypto,TextEncoder,TextDecoder,AbortController,Blob,Response,CompressionStream,DecompressionStream,atob,btoa,setTimeout,clearTimeout,setInterval,clearInterval,console});
 handlers.get('message')({source:parent,data:{type:'mokidown:extension-port'},ports:[ports.port2]});
 const command=(id,args)=>new Promise((resolve,reject)=>{const requestId=webcrypto.randomUUID();replies.set(requestId,{resolve,reject});ports.port1.postMessage({type:'command',id,args,requestId});});
 await wait(()=>statuses.size===2);
 return {disk,statuses,badges,storage,request,command,setNetworkFailure(value){networkFailure=value;},get comparison(){return comparison;},setDocuments(next){documents=next;ports.port1.postMessage({type:'event',name:'documentsChanged',payload:next});},close:async()=>{handlers.get('pagehide')?.();ports.port1.close();await storage.close();}};
}
for(const choice of ['local','remote','merged'])test(`document-scoped UI ${choice} action acknowledges real database completion`,async()=>{
 const f=await fixture();try{
  const db=await f.storage.get('sync:default');const [fileId,old]=Object.entries(db.files).find(([,file])=>file.fileName==='a.md');
  await f.request('net.request',{path:'/sync/file/'+fileId,method:'PUT',body:{content:'cloud a',compressed:false,size:7,checksum:hash('cloud a'),fileName:'a.md',baseRev:old.rev,mutationId:webcrypto.randomUUID()}});
  f.disk.set('a.md','local a');await f.command('sync.now');await wait(()=>[...f.statuses.values()].some(item=>item.text==='同步冲突'));
  assert.equal([...f.statuses.values()].find(item=>item.documentId==='b').text,'已同步');
  await f.command('sync.handle',{documentId:'a'});assert.deepEqual(Array.from(f.comparison.actions,action=>action.title),['使用本地','使用云端','应用修改']);
  const action=f.comparison.actions.find(action=>action.args.choice===choice);
  await f.command(action.command,{...action.args,document:{id:'a',path:'/notes/a.md',content:'local a',checksum:hash('local a')},draftContent:'merged a'});
  await wait(()=>[...f.statuses.values()].some(item=>item.documentId==='a'&&item.text==='冲突解决完成'));
  const expected=choice==='local'?'local a':choice==='remote'?'cloud a':'merged a';
  assert.equal(f.disk.get('a.md'),expected);assert.equal((await f.storage.get('sync:default')).files[fileId].content,expected);
  await f.command('sync.now');await wait(()=>[...f.statuses.values()].find(item=>item.documentId==='a')?.text==='冲突解决完成');
  f.setDocuments([{id:'outside',path:'/other/new.md',relativePath:null,active:true}]);await wait(()=>f.statuses.size===0);
 }finally{await f.close();}
});

test('failed sync replaces stale green badges and restores them only after retry',async()=>{
 const f=await fixture();try{
  await wait(()=>[...f.badges.values()].some(item=>item.id==='cloud-ok'&&item.paths.length===2));
  f.disk.set('a.md','unsent edit');f.setNetworkFailure(true);await f.command('sync.now');
  await wait(()=>[...f.statuses.values()].some(item=>item.documentId==='a'&&item.text==='同步失败'));
  const status=[...f.statuses.values()].find(item=>item.documentId==='a');assert.equal(status.tone,'error');assert.match(status.icon,/<path/);assert.match(status.icon,/#f85149/);
  const failed=f.badges.get('cloud-error');assert.ok(failed.paths.includes('a.md'));assert.equal(f.badges.get('cloud-ok').paths.length,0);assert.equal(f.disk.get('a.md'),'unsent edit');
  f.setNetworkFailure(false);await f.command('sync.now');await wait(()=>[...f.statuses.values()].every(item=>item.text==='已同步'));
  assert.equal(f.badges.has('cloud-error'),false);assert.equal(f.badges.get('cloud-ok').paths.length,2);
 }finally{await f.close();}
});
