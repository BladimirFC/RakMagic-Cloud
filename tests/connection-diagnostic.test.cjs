'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ConnectionDiagnostic,sanitizeConnectionDiagnostic}=require('../lib/connection-diagnostic.cjs');
const fixture=()=>({schema:1,protocol:'SA-MP 0.3.7',netgame:4057,currentState:3,
  attempted:true,transportAccepted:true,clientJoinSent:true,gameInitialized:true,spawnSent:true,launcherNoticeReceived:false,
  inboundPackets:4,inboundRpcs:1,malformedPackets:0,clientCheckCount:0,disconnectReason:'none',clientChecks:[],unhandledRpcs:[],
  packetInventoryAvailable:true,packetTypes:[{id:220,count:3,minBytes:2,maxBytes:60,lastBits:24,timestamped:1}]});
test('packet inventory retains only bounded numeric metadata and never packet content',()=>{
  const value=fixture();value.packetTypes[0].payload='synthetic-private-payload';value.password='synthetic-password';
  const result=sanitizeConnectionDiagnostic(value);
  assert.equal(result.packetInventoryAvailable,true);assert.equal(result.packetTypes[0].id,220);
  assert.doesNotMatch(JSON.stringify(result),/payload|password|synthetic/);
});
test('duplicate IDs, invalid sizes, impossible bit counts and oversized inventories are rejected',()=>{
  for(const mutate of [v=>v.packetTypes.push({...v.packetTypes[0]}),v=>v.packetTypes[0].id=256,
    v=>v.packetTypes[0].minBytes=0,v=>v.packetTypes[0].maxBytes=1,v=>v.packetTypes[0].lastBits=481,
    v=>v.packetTypes[0].timestamped=4,v=>v.packetTypes[0].count=-1,v=>v.packetTypes[0].count=1.5,
    v=>v.packetTypes=Array(257).fill(v.packetTypes[0]),v=>v.packetInventoryAvailable=false]){
    const value=fixture();mutate(value);assert.equal(sanitizeConnectionDiagnostic(value),null);
  }
});
test('legacy clients report the inventory as unavailable rather than complete and empty',()=>{
  const value=fixture();delete value.packetInventoryAvailable;delete value.packetTypes;
  const result=sanitizeConnectionDiagnostic(value);assert.equal(result.packetInventoryAvailable,false);
  assert.deepEqual(result.packetTypes,[]);
});
test('public packet inventories are isolated from later edits and separate clients',()=>{
  const first=new ConnectionDiagnostic(),second=new ConnectionDiagnostic();
  const event={type:'workerStatus',connectionDiagnostic:fixture()};first.observe(event);
  event.connectionDiagnostic.packetTypes[0].count=99;
  const report=first.report('Synthetic_Account',3,true);report.datos.packetTypes[0].count=100;
  assert.equal(first.report('Synthetic_Account',3,true).datos.packetTypes[0].count,3);
  assert.equal(second.report('Other_Account',0,true).datos,null);
});
