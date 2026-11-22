'use strict';
const fs=require('node:fs'),path=require('node:path');
const {prepareExecutable}=require('./executable-cache.cjs');
const CURRENT='rakmagic-worker-0.6.3-wg',LEGACY='rakmagic-worker';
function workerPath(directory,io=fs){
  const current=path.join(directory,CURRENT);
  return current;
}
function prepareWorker(directory,io=fs){return prepareExecutable(workerPath(directory,io),0o700,io);}
module.exports={CURRENT,LEGACY,workerPath,prepareWorker,prepareExecutable};
