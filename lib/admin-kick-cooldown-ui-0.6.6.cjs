'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const DELAY=20*60*1000,NOTICE_WINDOW=30000;
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const plain=value=>String(value??'').slice(0,4096).replace(/\{[a-f0-9]{6,8}\}/ig,'').replace(/~[a-z]~/ig,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
function isOwnAdminKick(value,nickname){
  const text=plain(value);
  if(!text||/\b(?:banead[oa]s?|bannead[oa]s?|banned|baneo)\b/.test(text))return false;
  // Player chat and public help/radio channels must not imitate an ADM notice.
  if(/\b(?:dice|grita|susurra|says|shouts)\s*:/.test(text)||/^\[(?:\/?duda|ooc|ic|radio|pm|mp|sms|global|chat)\]/.test(text))return false;
  const admin=/^(?:\[(?:adm|admin|administracion|administrador|staff|moderacion)\]|(?:adm|admin|administracion|administrador|staff|moderacion)\s*:)/.test(text);
  const attribution=/\b(?:administrador(?:a)?|administracion|administrator|admin|staff|moderador(?:a)?)\b/.test(text);
  const rejoin=/\breingres(?:a|e|ar|es|en)\b/.test(text);
  // Direct server messages address the recipient. Require attribution or the
  // server's reingresa reason, rather than matching the word on its own.
  const direct=/^(?:\[(?:adm|admin|staff|kick|expulsion)\]\s*)?(?:(?:has sido|fuiste|te han|te ha[n]?|you (?:have been|were))\s+(?:expulsad[oa]|kicked)|(?:un|el)\s+administrador\s+te\s+(?:ha\s+)?expulsado)/.test(text);
  if(direct&&(admin||attribution||rejoin))return true;
  if(!admin)return false;
  const names=[...new Set([plain(nickname),plain(nickname).replace(/_/g,' ')])];
  const own='(?:'+names.map(escape).join('|')+')';
  const before='(?:^|[^a-z0-9_])',after='(?=$|[^a-z0-9_])';
  const suffix='(?:\\s*\\[\\d+\\])?';
  // Match the target, never merely the administrator who performs the kick.
  const passive=new RegExp(before+own+after+suffix+'\\s+(?:fue|ha sido|has been|was)\\s+(?:expulsad[oa]|kicked)');
  const active=new RegExp('(?:expulso\\s+a|kicked)\\s+'+own+after);
  const sanction=new RegExp(before+own+after+suffix+'\\s+(?:fue|ha sido)\\s+sancionad[oa]');
  return passive.test(text)||active.test(text)||rejoin&&sanction.test(text);
}
const storageError=()=>Object.assign(new Error('No se pudo conservar la pausa de reconexion. La cuenta queda detenida para revision.'),{code:'RECONNECT_PAUSE_STORAGE'});
class AdminKickCooldown{
  constructor(directory,source,{now=Date.now}={}){
    this.now=now;this.source={host:String(source.host).toLowerCase().replace(/\.$/,''),port:source.port,nickname:String(source.nickname).toLowerCase()};
    const id=createHash('sha256').update(JSON.stringify(this.source)).digest('hex');
    this.file=path.join(directory,'state','reconnect-cooldown-'+id+'.json');this.until=0;this.pending=null;
    try{
      const stat=fs.statSync(this.file);if(!stat.isFile()||stat.size>4096)throw storageError();
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(data.v!==1||JSON.stringify(data.source)!==JSON.stringify(this.source)||!Number.isSafeInteger(data.startedAt)||!Number.isSafeInteger(data.until)||data.until-data.startedAt!==DELAY||data.reason!=='admin-kick')throw storageError();
      this.until=data.until;
    }catch(error){if(error.code!=='ENOENT')throw storageError();}
  }
  observe(text){
    if(isOwnAdminKick(text,this.source.nickname))this.pending={at:this.now()};
  }
  resetPending(){this.pending=null;}
  disconnected(reason){
    const pending=this.pending;this.pending=null;
    // A matching announcement alone is insufficient: the transport must close
    // soon afterwards, and a protocol ban is never converted into a 20m retry.
    if(!pending||this.now()-pending.at<0||this.now()-pending.at>NOTICE_WINDOW||/bloquead|banead|banned/i.test(String(reason)))return false;
    if(this.remaining()>0)return true; // Duplicate close events do not extend it.
    const startedAt=this.now(),until=startedAt+DELAY;
    const data={v:1,source:this.source,startedAt,until,reason:'admin-kick'};
    const temporary=this.file+'.tmp';
    try{
      fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
      fs.writeFileSync(temporary,JSON.stringify(data)+'\n',{mode:0o600});fs.chmodSync(temporary,0o600);fs.renameSync(temporary,this.file);
    }catch(_){this.until=until;throw storageError();}
    this.until=until;return true;
  }
  remaining(){return Math.max(0,this.until-this.now());}
  info(){const remaining=this.remaining();return{reconexionPausadaHasta:remaining?new Date(this.until).toISOString():null,reconexionPausaSegundos:Math.ceil(remaining/1000),motivoPausaReconex:remaining?'expulsion-administrativa':null};}
}
module.exports={AdminKickCooldown,isOwnAdminKick,DELAY,NOTICE_WINDOW};
