'use strict';

const flags=['attempted','transportAccepted','clientJoinSent','gameInitialized','spawnSent','launcherNoticeReceived'];
const counts=['inboundPackets','inboundRpcs','malformedPackets','clientCheckCount'];
const ends=new Set(['none','local-disconnect','server-disconnected','connection-lost','connection-banned','connection-attempt-failed','server-full','server-password-rejected','connection-timeout','connection-rejected','unsupported-auth-key']);
const uint=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;

// Explicit public metadata allowlist: never forward native packet bodies,
// profile fields, worker error text, passwords or host control tokens.
function sanitizeConnectionDiagnostic(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!==1||value.protocol!=='SA-MP 0.3.7'||value.netgame!==4057
    ||!uint(value.currentState,3)||flags.some(k=>typeof value[k]!=='boolean')||counts.some(k=>!uint(value[k]))
    ||!ends.has(value.disconnectReason)||!Array.isArray(value.clientChecks)||value.clientChecks.length>16
    ||!Array.isArray(value.unhandledRpcs)||value.unhandledRpcs.length>256)return null;
  const checks=[];
  for(const item of value.clientChecks){
    if(!item||!uint(item.type,255)||!uint(item.address,0xffffffff)||!uint(item.offset,65535)||!uint(item.byteCount,65535)
      ||typeof item.validRequest!=='boolean'||item.responseImplemented!==false)return null;
    checks.push({type:item.type,address:item.address,offset:item.offset,byteCount:item.byteCount,validRequest:item.validRequest,responseImplemented:false});
  }
  const unhandled=[];
  for(const item of value.unhandledRpcs){
    if(!item||!uint(item.id,255)||!uint(item.count)||!uint(item.lastBits,0xffffffff))return null;
    unhandled.push({id:item.id,count:item.count,lastBits:item.lastBits});
  }
  return {schema:1,protocol:value.protocol,netgame:4057,currentState:value.currentState,
    ...Object.fromEntries([...flags,...counts].map(k=>[k,value[k]])),accountAccessConfirmed:null,
    disconnectReason:value.disconnectReason,clientChecks:checks,unhandledRpcs:unhandled};
}

class ConnectionDiagnostic {
  constructor(now=Date.now){this.now=now;this.data=null;this.receivedAt=0;this.launcherCompatibility=null;}
  observe(event){
    if(event?.type!=='workerStatus'||!Object.hasOwn(event,'connectionDiagnostic'))return;
    const data=sanitizeConnectionDiagnostic(event.connectionDiagnostic);
    if(data){this.data=data;this.receivedAt=this.now();}
    const c=event.launcherCompatibility;
    const fields=['challengesReceived','malformedChallenges','responsesQueued','sendFailures'];
    if(c?.schema===1&&c.mode==='experimental-pc'&&typeof c.enabled==='boolean'
      &&typeof c.presenceAttempted==='boolean'&&typeof c.presenceQueued==='boolean'
      &&fields.every(k=>uint(c[k],0xffffffff))&&c.officialWorkerRunning===false&&c.serverAcceptanceConfirmed===null){
      this.launcherCompatibility={schema:1,modo:c.mode,activada:c.enabled,
        presenciaIntentada:c.presenceAttempted,presenciaEnCola:c.presenceQueued,
        peticionesRecibidas:c.challengesReceived,peticionesInvalidas:c.malformedChallenges,
        respuestasEnCola:c.responsesQueued,fallosEnvio:c.sendFailures,
        workerOficialEjecutandose:false,aceptacionServidorConfirmada:null};
      if(c.clientMode==='NORMAL'&&typeof c.modeAttempted==='boolean'
        &&typeof c.modeQueued==='boolean'&&typeof c.interfaceQueued==='boolean'){
        Object.assign(this.launcherCompatibility,{modoCliente:'NORMAL',
          anuncioModoIntentado:c.modeAttempted,anuncioModoEnCola:c.modeQueued,
          anuncioInterfazEnCola:c.interfaceQueued});
      }
    }
  }
  report(nickname,state,workerAvailable){
    return {schema:1,origen:'hosting',cuenta:nickname,disponible:!!this.data,clienteNativoDisponible:workerAvailable,
      estadoActual:state,recibidoEn:this.data?new Date(this.receivedAt).toISOString():null,
      antiguedadLecturaMs:this.data?Math.max(0,this.now()-this.receivedAt):null,
      datos:this.data?structuredClone(this.data):null,
      compatibilidadLauncher:this.launcherCompatibility?structuredClone(this.launcherCompatibility):null,
      aviso:this.data?'Metadatos del cliente del hosting. No confirman por si solos el acceso a la cuenta.':'El cliente nativo del hosting todavia no entrego un diagnostico compatible.'};
  }
}
module.exports={ConnectionDiagnostic,sanitizeConnectionDiagnostic};
