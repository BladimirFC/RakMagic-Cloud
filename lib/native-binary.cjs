'use strict';
const fs=require('node:fs'),path=require('node:path');
const CURRENT='rakmagic-worker-0.6.3-wg',LEGACY='rakmagic-worker';
function workerPath(directory,io=fs){
  const current=path.join(directory,CURRENT);
  return current;
}
function prepareExecutable(file,mode=0o700,io=fs){
  const name=path.basename(file);
  let stat;
  try{stat=io.statSync(file);}catch(error){
    const problem=new Error(error.code==='ENOENT'?'Falta '+name+'. Extrae el ZIP del programa con sus ejecutables en la carpeta de index.js.':'No se pudo leer '+name+'. Revisa los archivos del hosting.');
    problem.code=error.code==='ENOENT'?'NATIVE_MISSING':'NATIVE_UNREADABLE';throw problem;
  }
  if(!stat.isFile()||stat.size===0){const error=new Error(name+' no es un ejecutable valido o esta vacio. Reemplazalo con el archivo del ZIP.');error.code='NATIVE_INVALID';throw error;}
  try{io.chmodSync(file,mode);}catch(_){
    // A panel-owned file can already be executable even when chmod is denied.
    // Test the permission the running process actually needs before failing.
    try{io.accessSync(file,fs.constants.X_OK);return file;}catch(_){
      const error=new Error(name+' existe, pero no se puede ejecutar. Extrae el ZIP completo para instalar el ejecutable nuevo.');error.code='NATIVE_PERMISSION';throw error;
    }
  }
  try{io.accessSync(file,fs.constants.X_OK);}catch(_){
    const error=new Error('El hosting no permite ejecutar '+name+'. Revisa sus permisos de ejecucion en Archivos.');error.code='NATIVE_PERMISSION';throw error;
  }
  return file;
}
function prepareWorker(directory,io=fs){return prepareExecutable(workerPath(directory,io),0o700,io);}
module.exports={CURRENT,LEGACY,workerPath,prepareWorker,prepareExecutable};
