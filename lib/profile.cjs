'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {encode} = require('./encoding.cjs');
const LIMIT = 768*1024;
function loadJson(file) {
  if (fs.statSync(file).size > LIMIT) throw new Error('Archivo demasiado grande');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function fingerprint(publicKey) { return crypto.createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex'); }
function identity(directory) {
  fs.mkdirSync(path.join(directory,'state'),{recursive:true,mode:0o700});
  const file=path.join(directory,'state/host-key.pem');
  if(!fs.existsSync(file)) {
    if(fs.existsSync(path.join(directory,'cloud-profile.json'))) throw new Error('Falta la clave privada de este hosting; recupera su copia');
    const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
    fs.writeFileSync(file,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
  }
  fs.chmodSync(file,0o600);
  const privateKey=crypto.createPrivateKey(fs.readFileSync(file));
  const publicKey=crypto.createPublicKey(privateKey);
  if(publicKey.asymmetricKeyType!=='rsa'||publicKey.asymmetricKeyDetails.modulusLength!==3072) throw new Error('Clave del hosting no valida');
  const key={v:1,kind:'rakmagic-cloud-host',publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64'),fingerprint:fingerprint(publicKey)};
  fs.writeFileSync(path.join(directory,'host-key.json'),JSON.stringify(key,null,2)+'\n',{mode:0o644});
  return {privateKey,publicKey,fingerprint:key.fingerprint};
}
function validateProfile(p) {
  if(!p||p.v!==1||typeof p.host!=='string'||!p.host.match(/^[A-Za-z0-9.-]{1,253}$/)||!Number.isInteger(p.port)||p.port<1||p.port>65535) throw new Error('Servidor no valido');
  if(typeof p.nickname!=='string'||!p.nickname.match(/^[A-Za-z0-9_\[\]().$=@]{3,24}$/)) throw new Error('Nombre no valido');
  if(typeof p.serverPassword!=='string'||p.serverPassword.includes('\0')||encode(p.serverPassword).length>128) throw new Error('Clave de servidor no valida');
  if(p.newIpPassword!==undefined&&(typeof p.newIpPassword!=='string'||p.newIpPassword.includes('\0')||encode(p.newIpPassword).length>255))throw new Error('Clave de verificacion de IP no valida');
  if(typeof p.loginMessage!=='string'||encode(p.loginMessage).length>255||p.loginMessage.includes('\0')||p.loginMessage.trim().length>0&&p.loginMessage.trim().length<8) throw new Error('Aviso de acceso no valido');
  for(const flag of ['autoSpawn','afk','autoStart'])if(typeof p[flag]!=='boolean')throw new Error('Preferencias no validas');
  if(!Array.isArray(p.steps)||p.steps.length<1||p.steps.length>64) throw new Error('Recorrido no valido');
  for(const s of p.steps) {
    if(!s||!['textdraw','dialog','send','spawn','cancelSelection'].includes(s.kind)) throw new Error('Paso no valido');
    for(const [field,max] of Object.entries({text:1024,title:255,yes:255,value:s.kind==='send'?512:255,body:4096})) {
      if(typeof s[field]!=='string'||s[field].includes('\0')||encode(s[field]).length>max)throw new Error('Texto de paso no valido');
    }
    if(!Number.isInteger(s.style)||s.style<0||s.style>5||!Number.isInteger(s.item)||s.item< -1||s.item>4095||!Number.isFinite(s.x)||!Number.isFinite(s.y)||Math.abs(s.x)>100000||Math.abs(s.y)>100000||typeof s.accepted!=='boolean')throw new Error('Datos de paso no validos');
    if(s.kind==='send'&&!s.value)throw new Error('Mensaje vacio');
  }
  const r=p.reconnect;
  if(!r||typeof r.enabled!=='boolean'||!Number.isInteger(r.start)||!Number.isInteger(r.end)||r.start<0||r.end<0||r.start>=1440||r.end>=1440||r.start===r.end||typeof r.timeZone!=='string')throw new Error('Horario no valido');
  new Intl.DateTimeFormat('en-US',{timeZone:r.timeZone}).format();
  return p;
}
function decryptProfile(file,key) {
  const envelope=loadJson(file);
  if(envelope.v!==1||envelope.kind!=='rakmagic-cloud-profile'||envelope.fingerprint!==key.fingerprint)throw new Error('El perfil no pertenece a este hosting');
  const decode=(field,max)=>{
    const value=envelope[field];
    if(typeof value!=='string'||value.length>max||!value.match(/^[A-Za-z0-9+/]*={0,2}$/)||value.length%4)throw new Error('Archivo cifrado no valido');
    const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw new Error('Base64 no valido');return bytes;
  };
  const wrapped=decode('wrappedKey',1024),iv=decode('iv',32),ciphertext=decode('ciphertext',LIMIT);
  if(iv.length!==12||ciphertext.length<16||wrapped.length!==384)throw new Error('Sobre cifrado no valido');
  const aes=crypto.privateDecrypt({key:key.privateKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},wrapped);
  if(aes.length!==32)throw new Error('Clave de cifrado no valida');
  let plaintext;
  try {
    const decipher=crypto.createDecipheriv('aes-256-gcm',aes,iv);
    decipher.setAAD(Buffer.from('rakmagic.cloud.profile.v1:'+key.fingerprint));
    decipher.setAuthTag(ciphertext.subarray(-16));
    plaintext=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);
    return validateProfile(JSON.parse(plaintext.toString('utf8')));
  } finally { aes.fill(0);if(plaintext)plaintext.fill(0); }
}
function redact(text,p) {
  let value=String(text);
  const secrets=[p?.serverPassword,p?.newIpPassword,...(p?.steps||[]).filter(s=>s.kind==='send'||s.kind==='dialog'&&s.accepted&&(s.style===1||s.style===3)).map(s=>s.value)].filter(Boolean).sort((a,b)=>b.length-a.length);
  for(const secret of secrets)value=value.split(secret).join('[oculto]');
  return value;
}
module.exports={identity,validateProfile,decryptProfile,redact,fingerprint};
