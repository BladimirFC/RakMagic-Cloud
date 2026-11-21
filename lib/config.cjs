'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {parseEnv}=require('node:util');
const {encode}=require('./encoding.cjs');
const VARIABLE='RAKMAGIC_NEW_IP_PASSWORD';
function newIpPassword(directory,environment=process.env){
  let value=environment[VARIABLE];
  if(value===undefined){
    const file=path.join(directory,'.env');
    let stat;try{stat=fs.statSync(file);}catch(error){if(error.code==='ENOENT')return undefined;throw new Error('No se pudo leer .env');}
    if(!stat.isFile()||stat.size>16384)throw new Error('Archivo .env no valido');
    try{fs.chmodSync(file,0o600);value=parseEnv(fs.readFileSync(file,'utf8'))[VARIABLE];}
    catch(_){throw new Error('No se pudo leer .env');}
  }
  if(value!==undefined&&(typeof value!=='string'||value.includes('\0')||value.includes('\n')||value.includes('\r')||encode(value).length>255))throw new Error('Clave de nueva IP no valida');
  return value;
}
module.exports={newIpPassword};
