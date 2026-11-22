'use strict';
const fs=require('node:fs'),path=require('node:path');
const {prepareExecutable}=require('./executable-cache.cjs');
const CURRENT='rakmagic-worker-0.6.6-ui',LEGACY='rakmagic-worker';
function workerPath(directory,io=fs){
  const current=prepareExecutable(path.join(directory,'bin',CURRENT),0o700,io);
  return current;
}
function prepareWorker(directory,io=fs){return workerPath(directory,io);}
module.exports={CURRENT,LEGACY,workerPath,prepareWorker,prepareExecutable};
