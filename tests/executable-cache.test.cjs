'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {prepareExecutable}=require('../lib/executable-cache.cjs');
test('an active native process does not block replacement of deployment binaries',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-cache-test-'));
  let child;
  try{
    const source=path.join(temp,'worker'),cache=path.join(temp,'cache');
    fs.copyFileSync('/bin/sleep',source);
    const first=prepareExecutable(source,0o700,fs,cache);
    assert.notEqual(first,source);
    child=spawn(first,['30'],{stdio:'ignore'});await once(child,'spawn');
    assert.equal(prepareExecutable(source,0o700,fs,cache),first);
    fs.copyFileSync('/bin/true',source);
    const next=prepareExecutable(source,0o700,fs,cache);
    assert.notEqual(next,first);
    assert.deepEqual(fs.readFileSync(next),fs.readFileSync('/bin/true'));
    assert.equal(child.exitCode,null);
    const exited=once(child,'exit');child.kill('SIGTERM');await exited;child=null;
    fs.writeFileSync(next,'incomplete cache');
    assert.equal(prepareExecutable(source,0o700,fs,cache),next);
    assert.deepEqual(fs.readFileSync(next),fs.readFileSync(source));
  }finally{child?.kill('SIGTERM');fs.rmSync(temp,{recursive:true,force:true});}
});
test('missing deployment binaries fail before launching a process',()=>{
  assert.throws(()=>prepareExecutable('/not-a-real-rakmagic-file'),{code:'NATIVE_MISSING'});
});
