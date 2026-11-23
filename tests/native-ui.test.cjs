'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter,once}=require('node:events');
const base=path.join(__dirname,'..');
const {NativeUiDiagnostic,LIMITS}=require(path.join(base,'lib/native-ui-0.6.6.cjs'));
const {Worker}=require(path.join(base,'lib/worker-ui-0.6.6.cjs'));
const {CloudClient}=require(path.join(base,'app-0.6.9-ui.cjs'));
const {SessionManager}=require(path.join(base,'lib/sessions-ui-0.6.6.cjs'));
const b=(...n)=>Buffer.from(n),u16=n=>{const x=Buffer.alloc(2);x.writeUInt16LE(n);return x;};
const s16=s=>{const x=Buffer.from(s);return Buffer.concat([u16(x.length),x]);};
const frame=(...parts)=>Buffer.concat([b(248,10),...parts]);
const create=(w,id,kind)=>Buffer.concat([b(5,w),u16(id),u16(0),b(kind)]);
const prop=(w,id,n,value)=>Buffer.concat([b(7,w),u16(id),b(n),value]);
const event=bytes=>({type:'nativeUiPacket',bytes:bytes.length,hex:bytes.toString('hex')});
const screen=()=>frame(b(1,7),u16(0),create(7,20,3),prop(7,20,8,s16('Sí, es mía')),create(7,21,4),prop(7,21,8,s16('synthetic-password-never-log')),b(3,7));
test('visible captions and input IDs are read while input values stay absent',()=>{
  const d=new NativeUiDiagnostic();assert.equal(d.observe(event(screen())),true);
  const r=d.report(),json=JSON.stringify(r);assert.match(json,/Sí, es mía/);assert.doesNotMatch(json,/synthetic-password/);
  assert.equal(r.ventanas[0].controles.find(c=>c.id===21).campoEntrada,true);
  assert.equal(r.accionesEnviadas,0);assert.equal(r.accesoCuentaConfirmado,null);
});
test('a truncated batch is rejected atomically and never changes the last valid window',()=>{
  const d=new NativeUiDiagnostic();d.observe(event(screen()));const before=d.report().ventanas;
  const bytes=frame(b(1,9),u16(0),create(9,2,3),prop(9,2,8,Buffer.concat([u16(100),b(65)])));
  assert.equal(d.observe(event(bytes)),false);assert.deepEqual(d.report().ventanas,before);assert.equal(d.report().lecturaCompleta,false);
  assert.equal(d.report().ultimoError.code,'truncated');
});
test('unknown property aborts the batch without dumping any payload',()=>{
  const d=new NativeUiDiagnostic();d.observe(event(screen()));const before=d.report().ventanas;
  assert.equal(d.observe(event(frame(prop(7,20,250,Buffer.from('secret-after-unknown'))))),false);
  assert.deepEqual(d.report().ventanas,before);assert.equal(d.report().ultimoError.property,250);assert.doesNotMatch(JSON.stringify(d.report()),/secret-after-unknown|hex/);
});
test('a later valid update does not hide an earlier gap in the observed interface',()=>{
  const d=new NativeUiDiagnostic();d.observe(event(screen()));d.observe(event(frame(prop(7,20,250,b(99)))));
  assert.equal(d.observe(event(frame(prop(7,20,8,s16('Jugar'))))),true);
  assert.equal(d.report().lecturaCompleta,false);assert.equal(d.report().ultimoError.code,'unknown-property');
});
test('unknown control types never have their text retained',()=>{
  const d=new NativeUiDiagnostic();d.observe(event(frame(b(1,1),u16(0),create(1,1,99),prop(1,1,8,s16('unknown-secret')))));
  assert.doesNotMatch(JSON.stringify(d.report()),/unknown-secret/);
});
test('JSON interface messages are counted without retaining bodies',()=>{
  const d=new NativeUiDiagnostic();d.observe(event(b(248,3,...Buffer.from('{"password":"private-json"}'))));
  assert.equal(d.report().contadores.ignored,1);assert.doesNotMatch(JSON.stringify(d.report()),/private-json/);
});
test('all confirmed property widths keep the next caption aligned',()=>{
  const widths={1:8,2:8,3:8,4:4,5:4,6:8,7:8,9:5,10:2,11:1,12:1,13:4,14:8,18:1,19:3,20:2,21:1,22:2,24:4,25:4,26:5,27:16,28:5,29:4,30:8,31:1,32:1,33:12};
  const parts=[b(1,1),u16(0),create(1,1,3)];
  for(const [property,size] of Object.entries(widths))parts.push(prop(1,1,Number(property),Buffer.alloc(size)));
  parts.push(prop(1,1,15,b(2,65,66)),prop(1,1,16,s16('omit-image')),prop(1,1,17,Buffer.concat([b(1,65,1,66),Buffer.alloc(8)])),prop(1,1,23,s16('omit-placeholder')),prop(1,1,8,s16('Jugar')));
  const d=new NativeUiDiagnostic();assert.equal(d.observe(event(frame(...parts))),true);assert.equal(d.report().ventanas[0].controles[0].etiqueta,'Jugar');
  assert.doesNotMatch(JSON.stringify(d.report()),/omit-image|omit-placeholder/);
});
test('profile redaction and link omission run before a label enters the public report',()=>{
  const d=new NativeUiDiagnostic({redactText:s=>s.replaceAll('configured-secret','[oculto]')});
  d.observe(event(frame(b(1,1),u16(0),create(1,1,1),prop(1,1,8,s16('configured-secret https://example.com/a?token=sensitive')))));
  assert.doesNotMatch(JSON.stringify(d.report()),/configured-secret|sensitive|token=/);
});
test('separate accounts and reconnects have isolated and reset snapshots',()=>{
  const a=new NativeUiDiagnostic(),c=new NativeUiDiagnostic();a.observe(event(screen()));assert.equal(c.report().ventanas.length,0);
  a.setTransport({enabled:true,observed:10,captured:9,dropped:1});a.reset();assert.equal(a.report().ventanas.length,0);assert.equal(a.report().transporte.dropped,0);
});
test('oversized frames and window floods are bounded without retaining data',()=>{
  const d=new NativeUiDiagnostic();assert.equal(d.observe({type:'nativeUiPacket',bytes:LIMITS.frame+1,hex:''}),false);
  const parts=[];for(let i=0;i<33;i++)parts.push(b(1,i),u16(0));assert.equal(d.observe(event(frame(...parts))),false);assert.equal(d.report().ventanas.length,0);
});
test('public snapshot edits do not alter the internal model',()=>{
  const d=new NativeUiDiagnostic();d.observe(event(screen()));const r=d.report();r.ventanas[0].controles[0].etiqueta='modified';r.transporte.dropped=99;
  assert.equal(d.report().ventanas[0].controles[0].etiqueta,'Sí, es mía');assert.equal(d.report().transporte.dropped,0);
});
test('the worker adapter consumes private raw events before account listeners',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-ui-ipc-')),helper=path.join(dir,'fake-worker');
  fs.writeFileSync(helper,'#!/usr/bin/env node\n'+`process.stdout.write(${JSON.stringify(JSON.stringify(event(screen()))+'\n'+JSON.stringify({type:'workerReady',nativeUiObserver:true})+'\n')});\n`+"require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const id=Number(line.split(' ')[0]);process.stdout.write(JSON.stringify({type:'workerReply',request:id,ok:true})+'\\n');if(line.includes('quit'))process.exit(0);});\n",{mode:0o700});
  const worker=new Worker(helper,{nativeUiDiagnostics:true});const publicEvents=[];worker.on('event',e=>publicEvents.push(e));
  try{await once(worker,'event');assert.equal(publicEvents.some(e=>e.type==='nativeUiPacket'),false);assert.equal(worker.nativeInterface.report().ventanas.length,1);assert.doesNotMatch(JSON.stringify(publicEvents),/synthetic-password|hex/);}
  finally{await worker.close();fs.rmSync(dir,{recursive:true,force:true});}
});
function profile(){return {host:'127.0.0.1',port:7777,nickname:'Test_Account',afk:true,autoStart:false,autoSpawn:false,steps:[{kind:'send',value:'synthetic-password-never-log'}],reconnect:{enabled:false},loginMessage:'',serverPassword:''};}
test('diagnostic connect disables automation and pump never sends UI/password/AFK actions',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-ui-client-')),calls=[];
  class FakeWorker extends EventEmitter {constructor(){super();this.closed=false;this.child={pid:-1};}async command(...v){calls.push(v);return true;}async connect(){calls.push(['network-attempt-stub']);return true;}}
  const w=new FakeWorker(),c=new CloudClient(w,dir,profile(),{diagnosticOnly:true,afkOnly:true,restoreAccountChoice:false});
  try{assert.equal(await c.connect(),true);assert.equal(c.engine,null);assert.equal(c.afkWanted,false);await c.pump();assert.equal(await c.setAfk(true),false);assert.deepEqual(calls.map(x=>x[0]),['autoSpawn','network-attempt-stub']);assert.equal(calls[0][1],0);assert.doesNotMatch(JSON.stringify(calls),/synthetic-password/);}
  finally{c.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
test('saved wanted accounts are not restored when diagnostic autoStart is false',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-ui-start-')),p=profile();fs.mkdirSync(path.join(dir,'state'));
  const file=path.join(dir,'state/account-sessions.json'),before=JSON.stringify({v:1,source:{host:p.host,port:p.port,nickname:p.nickname},accounts:[{nickname:p.nickname,afk:true,wanted:true}]});fs.writeFileSync(file,before);
  try{const manager=new SessionManager(dir,p,{createClient:()=>{throw Error('Unexpected client creation');}});assert.deepEqual(manager.restoreNames,[]);assert.equal(manager.clients.size,0);assert.equal(fs.readFileSync(file,'utf8'),before);}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a manual diagnostic session preserves the saved AFK preference',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-ui-preference-')),p=profile();fs.mkdirSync(path.join(dir,'state'));
  const file=path.join(dir,'state/account-sessions.json');fs.writeFileSync(file,JSON.stringify({v:1,source:{host:p.host,port:p.port,nickname:p.nickname},accounts:[{nickname:p.nickname,afk:true,wanted:false}]}));
  class StubClient extends EventEmitter {constructor(){super();this.diagnosticOnly=true;this.afkWanted=false;this.profile=p;this.worker={closed:false};this.snapshot={state:0};this.desired=false;}status(){return {memoriaClienteMiB:0};}async connect(){return true;}}
  try{const manager=new SessionManager(dir,p,{createClient:async()=>new StubClient()});await manager.connectAccount(p.nickname);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).accounts[0].afk,true);}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});
