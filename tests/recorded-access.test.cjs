'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const {Automation}=require('../lib/automation.cjs');
const {RecordedAccess}=require('../lib/recorded-access.cjs');
const {CloudClient,createCloudClient}=require('../app-0.6.9-ui.cjs');
const {SessionManager}=require('../lib/sessions-ui-0.6.6.cjs');
const secret='synthetic-private-password';
const profile=()=>({host:'s1.newgamers.es',port:7777,nickname:'Synthetic_Account',afk:false,autoSpawn:false,autoStart:false,loginMessage:'',reconnect:{enabled:false},steps:[
  {kind:'dialog',style:0,title:'Confirmar cuenta',yes:'Si, es mia',body:'Recorded dynamic account body',accepted:true,item:-1,value:''},
  {kind:'dialog',style:3,title:'Contraseña',yes:'Entrar',body:'Ingresa la clave',accepted:true,item:-1,value:secret},
  {kind:'textdraw',style:1,text:'Jugar',x:10,y:10}
]});
const confirm=(name='Synthetic_Account',serial=1)=>({type:'dialog',serial,id:50,style:0,title:'Confirmar cuenta',yes:'Si, es mia',no:'No',body:'Usuario: '+name+'\nPersonajes: 1\nEntraste con el personaje '+name+', que pertenece a esta cuenta.'});
const password=(serial=2)=>({type:'dialog',serial,id:51,style:3,title:'Contraseña',yes:'Entrar',no:'Salir',body:'Ingresa la clave'});
const snapshot=()=>({state:3,dialog:null,selecting:false,textdraws:new Map()});
test('replays confirmation, one stored password and a moved JUGAR button, then requires a later server spawn',async()=>{
  let now=1000;const p=profile(),s=snapshot(),calls=[];
  const worker={closed:false,reply:async(...v)=>{calls.push(['reply',...v]);return true;},click:async(...v)=>{calls.push(['click',...v]);s.selecting=false;return true;}};
  const guard=new RecordedAccess(p,worker,()=>s,()=>now),engine=new Automation(p.steps,guard,now,{flexibleLogin:true});
  guard.observe({type:'spawnStatus',text:'Spawn enviado con la ubicacion del servidor.'});
  s.dialog=confirm();await engine.pump(s,now);assert.equal(engine.completed,1);
  now+=600;s.dialog=password();await engine.pump(s,now);assert.equal(engine.completed,2);
  s.selecting=true;s.textdraws.set(40,{id:40,revision:9,selectable:true,style:1,text:'JUGAR',x:300,y:300});
  now+=600;await engine.pump(s,now);assert.equal(engine.completed,3);
  assert.equal(guard.confirmed(3,3,true),false); // Pre-login spawn must not confirm access.
  guard.observe({type:'spawnStatus',text:'Spawn enviado con la ubicacion del servidor.'});
  assert.equal(guard.confirmed(3,3,true),false);now+=1100;
  assert.equal(guard.confirmed(3,3,true),true);
  assert.equal(calls.filter(c=>c[0]==='reply'&&c.at(-1)===secret).length,1);
  assert.deepEqual(calls.at(-1),['click',40,9]);assert.doesNotMatch(JSON.stringify(guard.report()),/synthetic-private/);
});
test('never confirms or sends credentials to a different account',async()=>{
  const s=snapshot(),calls=[],worker={closed:false,reply:async(...v)=>{calls.push(v);return true;}};
  const guard=new RecordedAccess(profile(),worker,()=>s),engine=new Automation(profile().steps,guard,1000,{flexibleLogin:true});
  s.dialog=confirm('Other_Account');await engine.pump(s,1000);
  assert.equal(engine.failed,true);assert.equal(calls.length,0);assert.equal(guard.report().claveEnviada,false);
});
test('direct password before identity confirmation and reopened password requests stop without guessing',async()=>{
  const s=snapshot(),calls=[],worker={closed:false,reply:async(...v)=>{calls.push(v);return true;}};
  const first=new RecordedAccess(profile(),worker,()=>s);s.dialog=password();
  await assert.rejects(()=>first.reply(2,51,true,-1,secret));assert.equal(calls.length,0);
  const guard=new RecordedAccess(profile(),worker,()=>s);s.dialog=confirm();await guard.reply(1,50,true,-1,'');
  s.dialog=password();await guard.reply(2,51,true,-1,secret);
  guard.observe(password(3));s.dialog=password(3);
  await assert.rejects(()=>guard.reply(3,51,true,-1,secret));
  assert.equal(calls.filter(c=>c.at(-1)===secret).length,1);
});
test('a failed native send stops replay and never retries the confirmation',async()=>{
  const s=snapshot();let calls=0;const worker={closed:false,reply:async()=>{calls++;return false;}};
  const p=profile(),guard=new RecordedAccess(p,worker,()=>s),engine=new Automation(p.steps,guard,1000,{flexibleLogin:true});
  s.dialog=confirm();await engine.pump(s,1000);await engine.pump(s,2000);
  assert.equal(engine.failed,true);assert.equal(calls,1);assert.equal(guard.identity,false);
});
test('chat commands and account management dialogs cannot consume a stored password',async()=>{
  const s=snapshot(),calls=[],worker={closed:false,reply:async(...v)=>{calls.push(v);return true;},send:async(...v)=>{calls.push(v);return true;}};
  const guard=new RecordedAccess(profile(),worker,()=>s);s.dialog=confirm();await guard.reply(1,50,true,-1,'');
  s.dialog={...password(),title:'Cambiar clave',body:'Escribe la nueva clave'};
  await assert.rejects(()=>guard.reply(2,51,true,-1,secret));await assert.rejects(()=>guard.send('/login '+secret));
  assert.equal(calls.length,1);
});
test('native event ordering can deliver the post-password spawn before the reply promise resolves',async()=>{
  let now=1000;const s=snapshot();let guard;
  const worker={closed:false,reply:async(_serial,_id,_yes,_item,value)=>{if(value===secret)guard.observe({type:'spawnStatus',text:'Spawn enviado con la ubicacion del servidor.'});return true;}};
  guard=new RecordedAccess(profile(),worker,()=>s,()=>now);s.dialog=confirm();await guard.reply(1,50,true,-1,'');
  s.dialog=password();await guard.reply(2,51,true,-1,secret);s.dialog=null;now+=1100;
  assert.equal(guard.confirmed(3,3,true),true);
});
test('one explicit IP verification is separate from the account password attempt',async()=>{
  const p=profile();p.newIpPassword='synthetic-ip-secret';const s=snapshot(),calls=[];
  const guard=new RecordedAccess(p,{closed:false,reply:async(...v)=>{calls.push(v);return true;}},()=>s);
  s.dialog={type:'dialog',serial:7,id:7,style:3,title:'# NewGamers Juego de Rol 1',yes:'>>>',no:'Salir',body:'Detectamos una nueva conexion IP\nPara continuar debes ingresar la clave con la que te registraste:'};
  await guard.reply(7,7,true,-1,p.newIpPassword);assert.equal(guard.report().verificacionIpEnviada,true);
  assert.equal(guard.report().claveEnviada,false);s.dialog={...s.dialog,serial:8};
  await assert.rejects(()=>guard.reply(8,7,true,-1,p.newIpPassword));assert.equal(calls.length,1);
});
test('a normal spawn request is sent once after credentials and tolerates a simultaneous server-authorized spawn',async()=>{
  const s=snapshot();let guard,calls=0;
  const worker={closed:false,reply:async()=>true,spawn:async()=>{calls++;guard.observe({type:'spawnStatus',text:'Spawn enviado con la ubicacion del servidor.'});return false;}};
  guard=new RecordedAccess(profile(),worker,()=>s);s.dialog=confirm();await guard.reply(1,50,true,-1,'');
  s.dialog=password();await guard.reply(2,51,true,-1,secret);s.dialog=null;
  assert.equal(await guard.spawn(),true);assert.equal(calls,1);
  await assert.rejects(()=>guard.spawn());assert.equal(calls,1);
});
test('CloudClient uses the recorded engine, preserves no-AFK mode and accepts only post-login proof',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-recorded-client-')),p=profile(),calls=[];
  class FakeWorker extends EventEmitter{constructor(){super();this.closed=false;}async reply(...v){calls.push(['reply',...v]);return true;}async click(...v){calls.push(['click',...v]);return true;}}
  const worker=new FakeWorker(),client=new CloudClient(worker,temp,p,{restoreAccountChoice:false,diagnosticOnly:true,recordedLogin:true,afkOnly:true});
  const manager=new SessionManager(temp,p,{createClient:async()=>client});manager.clients.set(p.nickname.toLowerCase(),client);
  try{
    client.desired=true;client.prepareLogin();client.snapshot.state=3;client.spawned=true;
    let clock=Date.now();client.loginGuard.now=()=>clock;
    worker.emit('event',confirm());await client.pump();
    await new Promise(r=>setTimeout(r,520));worker.emit('event',password());await client.pump();
    await new Promise(r=>setTimeout(r,520));
    worker.emit('event',{type:'selectTextdraw',enabled:true});
    worker.emit('event',{type:'textdraw',id:40,revision:1,selectable:true,style:1,text:'Jugar',x:10,y:10});
    await client.pump();assert.equal(client.engine.completed,3);assert.equal(client.accessCompleted,false);
    assert.equal(manager.getControlStatus().capacity.connected,0);
    worker.emit('event',{type:'selectTextdraw',enabled:false});
    worker.emit('event',{type:'spawnStatus',text:'Spawn enviado con la ubicacion del servidor.'});clock+=1100;
    await client.pump();assert.equal(client.accessCompleted,true);assert.equal(await client.setAfk(true),false);
    assert.equal(manager.getControlStatus().capacity.connected,1);
    const before=calls.length;await client.pump();assert.equal(calls.length,before);
    assert.equal(client.afkWanted,false);assert.equal(client.status().reconexion,false);
  }finally{client.dispose();fs.rmSync(temp,{recursive:true,force:true});}
});
test('a later unique Jugar button can finish a password-only recording, while ambiguity stops without clicking',async()=>{
  for(const buttonCount of [1,2]){
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-late-play-')),p=profile(),calls=[];p.steps=p.steps.slice(0,2);
    class FakeWorker extends EventEmitter{constructor(){super();this.closed=false;}async reply(){return true;}async click(...v){calls.push(v);return true;}}
    const worker=new FakeWorker(),client=new CloudClient(worker,temp,p,{restoreAccountChoice:false,diagnosticOnly:true,recordedLogin:true,afkOnly:true});
    try{
      client.desired=true;client.prepareLogin();client.snapshot.state=3;
      worker.emit('event',confirm());await client.pump();
      await new Promise(r=>setTimeout(r,520));worker.emit('event',password());await client.pump();
      assert.equal(client.engine.completed,2);
      worker.emit('event',{type:'selectTextdraw',enabled:true});
      for(let i=0;i<buttonCount;i++)worker.emit('event',{type:'textdraw',id:40+i,revision:1,selectable:true,style:1,text:'JUGAR',x:20+i,y:20});
      await client.pump();await client.pump();
      assert.equal(calls.length,buttonCount===1?1:0);
      assert.equal(client.blocked,buttonCount===2);assert.equal(client.accessCompleted,false);
    }finally{client.dispose();fs.rmSync(temp,{recursive:true,force:true});}
  }
});
test('the actual native worker enables recorded-login actions without connecting an account',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-recorded-ready-'));let client;
  try{
    client=await createCloudClient(temp,profile(),{diagnosticOnly:true,recordedLogin:true,nativeUiDiagnostics:true,afkOnly:true});
    assert.equal(client.worker.readyInfo.recordedLogin,true);assert.equal(client.worker.readyInfo.readOnlyUi,false);
    assert.equal(client.snapshot.state,0);assert.equal(client.desired,false);assert.equal(client.engine,undefined);
    assert.equal(client.afkWanted,false);
  }finally{if(client){await client.worker.close();client.dispose();}fs.rmSync(temp,{recursive:true,force:true});}
});
