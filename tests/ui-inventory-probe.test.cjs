'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {NativeUiDiagnostic}=require('../lib/native-ui-0.6.6.cjs');
const {CloudClient}=require('../app-0.6.8-ui.cjs');
const probe=()=>({requests:1,attempted:true,repliesSent:1,sendFailures:0,interfaceCount:0});
test('negotiation metadata reports a manual reply without claiming authentication or exposing extra fields',()=>{
  const value=new NativeUiDiagnostic();
  assert.equal(value.setNegotiation({...probe(),raw:'synthetic-private'}),true);
  const report=value.report();assert.equal(report.modo,'diagnostico-manual');
  assert.equal(report.negociacion.respuestasEnviadas,1);assert.equal(report.accionesEnviadas,1);
  assert.equal(report.accionesControlesEnviadas,0);assert.equal(report.negociacion.aceptacionServidorConfirmada,null);
  assert.doesNotMatch(JSON.stringify(report),/synthetic-private|raw/);
  value.reset();assert.equal(value.report().negociacion.respuestasEnviadas,0);
  assert.equal(value.report().modo,'solo-lectura');
});
test('invalid probe counters cannot replace the last valid metadata',()=>{
  const value=new NativeUiDiagnostic();value.setNegotiation(probe());const before=value.report().negociacion;
  for(const mutate of [p=>p.requests=0,p=>p.repliesSent=2,p=>p.sendFailures=1,p=>p.attempted=false,
    p=>p.interfaceCount=1,p=>p.requests=-1,p=>p.requests=1.5]){
    const p=probe();mutate(p);assert.equal(value.setNegotiation(p),false);
    assert.deepEqual(value.report().negociacion,before);
  }
});
test('manual negotiation targets only the connected diagnostic client and does not create login actions',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-probe-client-'));
  const worker=new EventEmitter(),calls=[];worker.closed=false;
  worker.command=async(...args)=>{calls.push(args);return true;};
  const profile={host:'example.invalid',port:7777,nickname:'Synthetic_Account',afk:false,steps:[],reconnect:{enabled:false}};
  let client;
  try{
    client=new CloudClient(worker,temp,profile,{restoreAccountChoice:false,diagnosticOnly:true});
    assert.equal(await client.negotiateUiInventory(),false);assert.equal(calls.length,0);
    client.snapshot.state=2;assert.equal(await client.negotiateUiInventory(),false);assert.equal(calls.length,0);
    client.snapshot.state=3;client.snapshot.dialog={title:'Confirm account'};
    assert.equal(await client.negotiateUiInventory(),false);assert.equal(calls.length,0);
    client.snapshot.dialog=null;assert.equal(await client.negotiateUiInventory(),true);
    assert.deepEqual(calls,[['uiInventoryEmpty']]);assert.equal(client.accessCompleted,false);
    await client.pump();assert.equal(calls.length,1);
    worker.closed=true;assert.equal(await client.negotiateUiInventory(),false);
  }finally{client?.dispose();fs.rmSync(temp,{recursive:true,force:true});}
});
