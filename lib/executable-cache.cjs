'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash,randomUUID}=require('node:crypto');
const CACHE=path.join(os.tmpdir(),'rakmagic-native-'+(process.getuid?.()??'user'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function prepareExecutable(file,mode=0o700,io=fs,cacheRoot=CACHE){
  const name=path.basename(file);let bytes;
  try{
    const stat=io.statSync(file);
    if(!stat.isFile()||stat.size===0||stat.size>64*1024*1024)throw Object.assign(Error('Archivo nativo no valido: '+name),{code:'NATIVE_INVALID'});
    bytes=io.readFileSync(file);
  }catch(error){
    if(error.code==='NATIVE_INVALID')throw error;
    throw Object.assign(Error('No se pudo leer '+name+'. Comprueba que el despliegue termino.'),{code:error.code==='ENOENT'?'NATIVE_MISSING':'NATIVE_UNREADABLE'});
  }
  // Deployment replaces only the source in bin/. Running processes use an
  // immutable copy, so later uploads cannot fail with ETXTBSY on that source.
  const hash=digest(bytes),directory=path.join(cacheRoot,hash),target=path.join(directory,name);
  let temporary;
  try{
    io.mkdirSync(directory,{recursive:true,mode:0o700});
    let ready=false;
    try{ready=io.lstatSync(target).isFile()&&digest(io.readFileSync(target))===hash;}catch(_){}
    if(!ready){
      temporary=path.join(directory,'.'+process.pid+'-'+randomUUID());
      io.writeFileSync(temporary,bytes,{flag:'wx',mode});
      io.renameSync(temporary,target);temporary=null;
    }
    io.chmodSync(target,mode);io.accessSync(target,fs.constants.X_OK);return target;
  }catch(_){
    throw Object.assign(Error('No se pudo preparar la copia de ejecucion de '+name+'.'),{code:'NATIVE_PERMISSION'});
  }finally{if(temporary)try{io.unlinkSync(temporary);}catch(_){}}
}
module.exports={prepareExecutable};
