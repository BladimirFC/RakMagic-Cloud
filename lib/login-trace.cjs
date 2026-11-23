'use strict';
const {redact}=require('./profile.cjs');
const {encode,decoder}=require('./encoding.cjs');
const number=value=>Number.isFinite(value)?value:null;
const integer=value=>Number.isSafeInteger(value)?value:null;
const labels=/launcher|contrase|password|acceso|login|bienvenid|conect|cuenta|seguridad|verifica|confirm|expuls|rechaz|bloque|permit|registr|iniciar|entrar/i;

// Only already-visible server text is retained. Never copy a profile/step object
// or any value supplied to a dialog, command, or worker. Redact again after
// formatting removal so color codes cannot expose a known secret on export.
class LoginTrace {
  constructor(profile,now=Date.now){this.profile=profile;this.now=now;this.reset();}
  reset(){this.messages=[];this.dialogs=[];this.lastDialog=null;this.failure=null;this.started=this.now();}
  clean(value,limit=1024){
    let text=redact(String(value??''),this.profile);
    text=text.replace(/\{[0-9a-f]{6}\}/gi,'').replace(/~n~/gi,'\n').replace(/~[rgbypwsh]~/gi,'')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
    text=redact(text,this.profile);
    const extras=[];
    for(const step of this.profile.steps||[]){
      if(step.kind==='send')extras.push(...String(step.value||'').trim().split(/\s+/).slice(1));
      if(step.kind==='dialog'&&step.accepted&&[1,3].includes(step.style))extras.push(step.value);
    }
    extras.push(this.profile.serverPassword,this.profile.newIpPassword);
    for(const secret of extras.filter(v=>typeof v==='string'&&v).sort((a,b)=>b.length-a.length)){
      text=text.split(secret).join('[oculto]');
      try{const wire=decoder.decode(encode(secret));if(wire)text=text.split(wire).join('[oculto]');}catch(_){}
    }
    return text.slice(0,limit);
  }
  dialog(dialog){
    if(!dialog)return null;
    return {titulo:this.clean(dialog.title,255),estilo:integer(dialog.style),aceptar:this.clean(dialog.yes,255),
      cancelar:this.clean(dialog.no,255),contenido:this.clean(dialog.body,8192)};
  }
  observe(event){
    // Native ClientMessage RPCs always carry this generated color prefix.
    // Local status/debug logs and player chat must not look like a kick reason.
    if(event?.type==='log'&&/^\{[0-9a-f]{6}\}/i.test(String(event.text||''))){
      this.messages.push({recibidoEn:new Date(this.now()).toISOString(),texto:this.clean(event.text)});
      if(this.messages.length>16)this.messages.shift();
    }
    if(event?.type==='dialog'){
      this.lastDialog={recibidoEn:new Date(this.now()).toISOString(),...this.dialog(event)};
      this.dialogs.push(this.lastDialog);if(this.dialogs.length>8)this.dialogs.shift();
    }
  }
  step(engine){
    const step=this.profile.steps?.[engine?.completed??0];
    if(!step)return null;
    return {tipo:this.clean(step.kind,32),titulo:this.clean(step.title,255),estilo:integer(step.style),
      aceptar:this.clean(step.yes,255),boton:this.clean(step.text,512),x:number(step.x),y:number(step.y)};
  }
  screen(snapshot,engine,spawned){
    const textdraws=snapshot?.textdraws instanceof Map?[...snapshot.textdraws.values()]:[];
    const visible=td=>({id:integer(td.id),estilo:integer(td.style),x:number(td.x),y:number(td.y),texto:this.clean(td.text,512)});
    return {estado:integer(snapshot?.state),aparicionEnviada:!!spawned,seleccionActiva:snapshot?.selecting===true,
      pasosEnviados:engine?.completed??0,pasosGrabados:this.profile.steps?.length??0,pasoEsperado:this.step(engine),
      dialogo:this.dialog(snapshot?.dialog),botones:textdraws.filter(td=>td.selectable).slice(0,16).map(visible),
      etiquetas:textdraws.filter(td=>!td.selectable&&labels.test(String(td.text||''))).slice(0,24).map(visible)};
  }
  closed(snapshot,engine,spawned,paused){
    this.failure={recibidoEn:new Date(this.now()).toISOString(),motivo:'servidor-cerro-durante-acceso',
      reintentosPausados:!!paused,pantalla:this.screen(snapshot,engine,spawned)};
  }
  report(snapshot,engine,spawned){
    return structuredClone({iniciadoEn:new Date(this.started).toISOString(),estadoActual:this.screen(snapshot,engine,spawned),
      cierreDuranteAcceso:this.failure,ultimoDialogoRecibido:this.lastDialog,dialogosRecibidos:this.dialogs,mensajesServidor:this.messages,
      aviso:'Texto visible del servidor con las credenciales conocidas ocultas. El ultimo mensaje no necesariamente es el motivo de la desconexion.'});
  }
}
module.exports={LoginTrace};
