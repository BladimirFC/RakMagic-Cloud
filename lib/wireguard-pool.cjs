'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {EventEmitter}=require('node:events');
const {validNickname}=require('./accounts.cjs');
const {WireGuard}=require('./wireguard.cjs');
const failure=message=>Object.assign(new Error(message),{code:'WIREGUARD'});

// Assignments are stable until a full restart. No rotation, shared-key tunnel
// cloning, classification by geolocation, or direct-network fallback.
class WireGuardPool extends EventEmitter {
  constructor(directory,{enabled=false,distinct=false,file='wireguard.conf'}={}){
    super();this.directory=directory;this.enabled=enabled;this.distinct=distinct;
    this.defaultFile=file;this.assignments=new Map();this.accounts=new Map();this.reports=new Map();this.tunnels=new Map();this.closed=false;
    if(distinct&&!enabled)throw failure('Las salidas distintas requieren RAKMAGIC_WG_ENABLED=1.');
    const config=path.join(directory,'wireguard-accounts.json');
    if(fs.existsSync(config)){
      try{
        if(fs.statSync(config).size>16384)throw Error();
        const data=JSON.parse(fs.readFileSync(config,'utf8'));
        if(data.version!==1||!Array.isArray(data.accounts)||data.accounts.length>30)throw Error();
        const files=new Set();
        for(const entry of data.accounts){
          if(!validNickname(entry.nickname)||typeof entry.config!=='string'||!/^wireguard\/[A-Za-z0-9_-]+\.conf$/.test(entry.config))throw Error();
          const id=entry.nickname.toLowerCase();
          if(this.assignments.has(id)||files.has(entry.config))throw Error();
          files.add(entry.config);this.assignments.set(id,{nickname:entry.nickname,file:entry.config});
        }
      }catch(_){throw failure('wireguard-accounts.json no es valido: usa cuentas y archivos wireguard/nombre.conf distintos.');}
    }else if(distinct)throw failure('Falta wireguard-accounts.json. Asigna una configuracion privada distinta a cada cuenta.');
    this.timer=setInterval(()=>this.monitor().catch(()=>{}),15000);this.timer.unref();
  }
  credentialFingerprint(file){
    try{
      const target=fs.realpathSync(path.resolve(this.directory,file));
      const stat=fs.statSync(target);if(!stat.isFile()||stat.size<32||stat.size>65536)throw Error();
      const data=fs.readFileSync(target,'utf8');
      const key=data.match(/^\s*PrivateKey\s*=\s*([A-Za-z0-9+/]{43}=)\s*$/m)?.[1];
      if(!key)throw Error();
      // Private material never leaves this function, appears in diagnostics,
      // or gets written to another file. Only an in-memory digest is retained.
      return createHash('sha256').update(Buffer.from(key,'base64')).digest('hex');
    }catch(_){throw failure('Falta una configuracion WireGuard valida para esta cuenta. Revisa el archivo asignado.');}
  }
  async acquire(name){
    if(this.closed)throw failure('El hosting se esta cerrando.');
    if(!validNickname(name))throw failure('Nombre de cuenta no valido.');
    const id=name.toLowerCase(),assignment=this.assignments.get(id);
    if(this.distinct&&!assignment)throw failure('Esta cuenta no tiene una conexion asignada en wireguard-accounts.json.');
    const tunnelID=assignment?id:'shared';
    let entry=this.tunnels.get(tunnelID);
    if(entry?.closing){await entry.closing;entry=this.tunnels.get(tunnelID);}
    if(entry?.vpn.failed)throw failure(entry.vpn.failure||'El tunel se detuvo. Desconecta la cuenta y reinicia el hosting.');
    if(!entry){
      const file=assignment?.file||this.defaultFile;
      const fingerprint=this.enabled?this.credentialFingerprint(file):null;
      for(const other of this.tunnels.values())if(fingerprint&&other.fingerprint===fingerprint)throw failure('Dos configuraciones usan la misma clave WireGuard. Necesitas credenciales de tuneles distintos.');
      entry={vpn:new WireGuard(this.directory,{enabled:this.enabled,file}),names:new Map(),fingerprint};
      entry.vpn.on('notice',message=>this.emit('notice',assignment?'['+name+'] '+message:message));
      entry.vpn.beforeUse=()=>this.check(entry);
      entry.vpn.checkBeforeWorker=()=>this.checkDistinct(entry);
      this.tunnels.set(tunnelID,entry);
    }
    entry.names.set(id,name);this.accounts.set(id,entry);
    try{await entry.vpn.start();await this.check(entry);return entry.vpn;}
    catch(error){if(this.distinct)entry.vpn.failure=error.message;await this.release(name,entry.vpn);throw error;}
  }
  checkDistinct(entry){
    if(!this.distinct)return;
    if(!entry.vpn.egressFresh())throw failure('No hay una verificacion UDP vigente. Conexion bloqueada.');
    for(const other of this.tunnels.values()){
      if(other===entry||!other.names.size||other.closing||other.vpn.failed)continue;
      if(!other.vpn.egressFresh())throw failure('Otra cuenta tiene la verificacion de salida pendiente o caducada. Conexion bloqueada.');
      if(other.vpn.egress===entry.vpn.egress)throw failure('IP de salida compartida con '+[...other.names.values()].join(', ')+'. Esta conexion queda bloqueada.');
    }
  }
  async check(entry,{force=false}={}){
    if(!this.enabled)return;
    await entry.vpn.verify({force});
    // Commit/check is synchronous: concurrent probes cannot both reserve the
    // same observed address without the later completion seeing the conflict.
    this.checkDistinct(entry);
  }
  async monitor(){
    if(this.closed)return;
    if(this.distinct){
      for(const entry of this.tunnels.values()){
        if(entry.names.size&&!entry.closing&&entry.vpn.ready&&!entry.vpn.failed&&entry.vpn.egressAt&&!entry.vpn.egressFresh())entry.vpn.block('La verificacion de salida ha caducado. Cuenta detenida.');
      }
    }
    if(this.monitoring)return;
    this.monitoring=true;
    try{
      for(const entry of this.tunnels.values()){
        if(!entry.names.size||entry.closing||!entry.vpn.ready||entry.vpn.failed)continue;
        if(Date.now()-entry.vpn.egressAttemptAt<60000)continue;
        try{await this.check(entry,{force:true});}
        catch(error){if(this.distinct)entry.vpn.block(error.message);}
      }
    }finally{this.monitoring=false;}
  }
  async verify(name){
    const entries=name?[this.accounts.get(name.toLowerCase())].filter(Boolean):[...this.tunnels.values()];
    if(!entries.length)throw failure('Conecta la cuenta para consultar su tunel.');
    for(const entry of entries){
      try{await this.check(entry,{force:true});}
      catch(error){if(this.distinct)entry.vpn.block(error.message);throw error;}
    }
    return this.info(name);
  }
  async release(name,vpn){
    const id=name.toLowerCase(),entry=this.accounts.get(id);
    if(!entry||entry.vpn!==vpn)return;
    this.reports.delete(id);this.reports.set(id,{cuenta:entry.names.get(id),cuentaActiva:false,...entry.vpn.info()});
    while(this.reports.size>30)this.reports.delete(this.reports.keys().next().value);
    this.accounts.delete(id);entry.names.delete(id);
    if(entry.names.size)return;
    if(!entry.closing)entry.closing=entry.vpn.close();
    await entry.closing;
    for(const [key,value] of this.tunnels)if(value===entry)this.tunnels.delete(key);
  }
  info(name){
    const records=new Map([...this.reports].map(([id,row])=>[id,{...row,ipSalidaVerificada:null,verificacionVigente:false,adaptadorPreparado:false,intercambioConfirmado:false}]));
    for(const [id,entry] of this.accounts)records.set(id,{cuenta:entry.names.get(id),cuentaActiva:true,...entry.vpn.info()});
    const rows=[...records.values()];
    return {activado:this.enabled,salidasDistintasExigidas:this.distinct,conexionDirectaPermitida:!this.enabled,
      cuentas:name?rows.filter(row=>row.cuenta.toLowerCase()===name.toLowerCase()):rows,
      cuentasConfiguradas:[...this.assignments.values()].map(a=>a.nickname),
      aviso:'Dos perfiles VPN pueden compartir IP. Solo se comprueban las salidas IPv4 observadas por STUN; no acredita conexion residencial, ubicacion ni aceptacion del juego.'};
  }
  memoryMiB(){return [...this.tunnels.values()].reduce((sum,e)=>sum+e.vpn.memoryMiB(),0);}
  async close(){this.closed=true;clearInterval(this.timer);await Promise.allSettled([...this.tunnels.values()].map(e=>e.vpn.close()));this.accounts.clear();this.tunnels.clear();}
}
module.exports={WireGuardPool};
