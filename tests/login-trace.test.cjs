'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LoginTrace}=require('../lib/login-trace.cjs');
const profile={steps:[{kind:'dialog',accepted:true,style:1,value:'synthetic-secret'}]};
const dialog=title=>({type:'dialog',title,style:0,yes:'Continue',no:'',body:'Visible text synthetic-secret'});
const snapshot={state:0,dialog:null,textdraws:new Map()};
test('login prompt history survives a later timeout dialog without exposing configured inputs',()=>{
  const trace=new LoginTrace(profile);trace.observe(dialog('Confirm account'));trace.observe(dialog('Login timeout'));
  const report=trace.report(snapshot,null,false);
  assert.deepEqual(report.dialogosRecibidos.map(d=>d.titulo),['Confirm account','Login timeout']);
  assert.equal(report.ultimoDialogoRecibido.titulo,'Login timeout');
  assert.doesNotMatch(JSON.stringify(report),/synthetic-secret/);
  report.dialogosRecibidos[0].titulo='changed';
  assert.equal(trace.report(snapshot,null,false).dialogosRecibidos[0].titulo,'Confirm account');
});
test('dialog history is bounded and reset between connection attempts',()=>{
  const trace=new LoginTrace(profile),other=new LoginTrace(profile);
  for(let i=0;i<12;i++)trace.observe(dialog('Dialog '+i));
  assert.equal(trace.report(snapshot,null,false).dialogosRecibidos.length,8);
  assert.equal(trace.report(snapshot,null,false).dialogosRecibidos[0].titulo,'Dialog 4');
  assert.deepEqual(other.report(snapshot,null,false).dialogosRecibidos,[]);
  trace.reset();assert.deepEqual(trace.report(snapshot,null,false).dialogosRecibidos,[]);
  assert.equal(trace.report(snapshot,null,false).ultimoDialogoRecibido,null);
});
