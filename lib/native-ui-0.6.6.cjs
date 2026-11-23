'use strict';

// Read-only decoder for the native F4 interface in the supplied Data DLL.
// Never decode/store text-input values, image URLs, JSON bodies or packet dumps.
const LIMITS=Object.freeze({frame:65536,windows:32,elements:2048,operations:8192,reportElements:256,text:180});
const FIXED=Object.freeze({1:8,2:8,3:8,4:4,5:4,6:8,7:8,9:5,10:2,11:1,12:1,13:4,14:8,18:1,19:3,20:2,21:1,22:2,24:4,25:4,26:5,27:16,28:5,29:4,30:8,31:1,32:1,33:12});
const utf8=new TextDecoder('utf-8',{fatal:true}),legacy=new TextDecoder('windows-1252');
class DecodeError extends Error {constructor(code,offset,details={}){super(code);this.code=code;this.offset=offset;this.details=details;}}
class Reader {
  constructor(bytes){this.bytes=bytes;this.pos=0;}
  need(n){if(!Number.isSafeInteger(n)||n<0||n>this.bytes.length-this.pos)throw new DecodeError('truncated',this.pos);}
  u8(){this.need(1);return this.bytes[this.pos++];}
  u16(){this.need(2);const n=this.bytes.readUInt16LE(this.pos);this.pos+=2;return n;}
  f32(){this.need(4);const n=this.bytes.readFloatLE(this.pos);this.pos+=4;return n;}
  skip(n){this.need(n);this.pos+=n;}
  span(n){this.need(n);const b=this.bytes.subarray(this.pos,this.pos+n);this.pos+=n;return b;}
  string8(){return this.span(this.u8());}
  string16(){return this.span(this.u16());}
}
function text(bytes){try{return utf8.decode(bytes);}catch(_){return legacy.decode(bytes);}}
function clean(value,redact){
  return String(redact(value)).replace(/\{[0-9a-fA-F]{6}\}/g,'').replace(/https?:\/\/\S+/gi,'[enlace omitido]').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,LIMITS.text);
}
const cloneWindows=windows=>new Map([...windows].map(([id,w])=>[id,{...w,elements:new Map([...w.elements].map(([eid,e])=>[eid,{...e}]))}]));
class NativeUiDiagnostic {
  constructor({now=Date.now,redactText=value=>value}={}){this.now=now;this.redactText=redactText;this.transport={enabled:false,observed:0,captured:0,dropped:0};this.reset();}
  reset(){this.transport={enabled:this.transport.enabled,observed:0,captured:0,dropped:0};this.negotiation={requests:0,attempted:false,repliesSent:0,sendFailures:0,interfaceCount:0};this.windows=new Map();this.counts={frames:0,batches:0,decoded:0,rejected:0,ignored:0};this.opcodes=new Map();this.lastReceived=0;this.lastError=null;this.revision=0;}
  setNegotiation(value){
    if(!value||typeof value.attempted!=='boolean'||value.interfaceCount!==0
      ||['requests','repliesSent','sendFailures'].some(k=>!Number.isSafeInteger(value[k])||value[k]<0)
      ||value.repliesSent+value.sendFailures>1||value.attempted!==(value.repliesSent+value.sendFailures===1)
      ||(value.attempted&&value.requests===0))return false;
    this.negotiation={requests:value.requests,attempted:value.attempted,repliesSent:value.repliesSent,sendFailures:value.sendFailures,interfaceCount:0};return true;
  }
  setTransport(value){
    if(!value||typeof value.enabled!=='boolean'||['observed','captured','dropped'].some(k=>!Number.isSafeInteger(value[k])||value[k]<0))return;
    this.transport={enabled:value.enabled,observed:value.observed,captured:value.captured,dropped:value.dropped};
  }
  reject(code,offset=0,details={}){this.counts.rejected++;this.lastError={code,offset,...details};}
  observe(event){
    if(event?.type!=='nativeUiPacket')return false;
    this.counts.frames++;this.lastReceived=this.now();
    if(!Number.isInteger(event.bytes)||event.bytes<2||event.bytes>LIMITS.frame||typeof event.hex!=='string'||event.hex.length!==event.bytes*2||!/^[a-f0-9]+$/.test(event.hex)){
      this.reject('invalid-envelope');return false;
    }
    const bytes=Buffer.from(event.hex,'hex');
    try{
      const r=new Reader(bytes);
      if(r.u8()!==248)throw new DecodeError('wrong-packet',0);
      const opcode=r.u8();this.opcodes.set(opcode,(this.opcodes.get(opcode)||0)+1);
      if(opcode!==10){this.counts.ignored++;return true;}
      this.counts.batches++;
      const next=cloneWindows(this.windows);let operations=0;
      while(r.pos<bytes.length){
        if(++operations>LIMITS.operations)throw new DecodeError('operation-limit',r.pos);
        const operation=r.u8();if(operation===0){if(r.pos!==bytes.length)throw new DecodeError('trailing-bytes',r.pos);break;}
        const wid=r.u8();let window=next.get(wid);
        switch(operation){
          case 1:{
            const mode=r.u16();
            if(!next.has(wid)&&next.size>=LIMITS.windows)throw new DecodeError('window-limit',r.pos);
            next.set(wid,{id:wid,mode,visible:null,title:'',elements:new Map()});break;
          }
          case 2:next.delete(wid);break;
          case 3:if(window)window.visible=true;break;
          case 4:if(window)window.visible=false;break;
          case 5:{
            const id=r.u16(),parent=r.u16(),kind=r.u8();
            if(!id)break;
            const total=[...next.values()].reduce((n,w)=>n+w.elements.size,0);
            if(window&&!window.elements.has(id)&&total>=LIMITS.elements)throw new DecodeError('element-limit',r.pos);
            if(window)window.elements.set(id,{id,parent,kind,label:'',enabled:null,visible:null,interactive:null});break;
          }
          case 6:{const id=r.u16();window?.elements.delete(id);break;}
          case 7:{
            const id=r.u16(),property=r.u8(),element=window?.elements.get(id);
            this.property(r,property,element);break;
          }
          case 8:{const title=r.string8();if(window)window.title=clean(text(title),this.redactText);break;}
          // The native callback changes focus/visibility through this operation.
          // Do not infer that the account is authenticated from it.
          case 9:if(window)window.visible=null;break;
          default:throw new DecodeError('unknown-operation',r.pos-2,{operation});
        }
      }
      this.windows=next;this.counts.decoded++;this.revision++;return true;
    }catch(error){
      if(error instanceof DecodeError)this.reject(error.code,error.offset,error.details);
      else this.reject('decode-failed');
      return false;
    }finally{bytes.fill(0);}
  }
  property(r,property,element){
    if(property===1||property===2){const x=r.f32(),y=r.f32();if(element&&[x,y].every(n=>Number.isFinite(n)&&Math.abs(n)<=1e6))element[property===1?'position':'size']=[x,y];return;}
    if(property===8){
      const label=r.string16();
      // Type 4 is the text editor, including its password mode. Do not even
      // convert its bytes to a JS string. Unknown control types fail closed.
      if(element&&[1,2,3,5,6,7,8].includes(element.kind))element.label=clean(text(label),this.redactText);
      return;
    }
    if(property===15){r.string8();return;}
    if(property===16||property===23){r.string16();return;}
    if(property===17){r.string8();r.string8();r.skip(8);return;}
    const size=FIXED[property];
    if(size===undefined)throw new DecodeError('unknown-property',r.pos-1,{property});
    if(property===10){const visible=r.u8(),enabled=r.u8();if(element){element.visible=!!visible;element.enabled=!!enabled;}return;}
    if(property===12){const interactive=r.u8();if(element)element.interactive=!!interactive;return;}
    r.skip(size);
  }
  report(){
    let remaining=LIMITS.reportElements,total=0;
    const windows=[...this.windows.values()].map(w=>{
      total+=w.elements.size;
      const elements=[...w.elements.values()].sort((a,b)=>a.id-b.id).slice(0,remaining).map(e=>({id:e.id,parent:e.parent,tipo:e.kind,campoEntrada:e.kind===4,etiqueta:e.kind===4?'[valor omitido]':e.label,visible:e.visible,habilitado:e.enabled,interactivo:e.interactive,...(e.position?{posicion:[...e.position]}:{}),...(e.size?{tamano:[...e.size]}:{})}));
      remaining-=elements.length;
      return {id:w.id,modo:w.mode,visible:w.visible,titulo:w.title,totalControles:w.elements.size,controles:elements};
    });
    return {schema:1,modo:this.negotiation.attempted?'diagnostico-manual':'solo-lectura',protocolo:'interfaz-nativa-F4',transporte:{...this.transport},revision:this.revision,
      recibidoEn:this.lastReceived?new Date(this.lastReceived).toISOString():null,antiguedadMs:this.lastReceived?Math.max(0,this.now()-this.lastReceived):null,
      contadores:{...this.counts},operacionesRecibidas:[...this.opcodes].map(([id,count])=>({id,count})),
      lecturaCompleta:this.counts.decoded>0&&this.counts.rejected===0&&this.counts.ignored===0&&this.transport.dropped===0,
      ultimoError:this.lastError?{...this.lastError}:null,totalControles:total,truncado:total>LIMITS.reportElements,ventanas:windows,
      negociacion:{solicitudes:this.negotiation.requests,intentoRealizado:this.negotiation.attempted,respuestasEnviadas:this.negotiation.repliesSent,
        fallosEnvio:this.negotiation.sendFailures,interfacesAnunciadas:0,aceptacionServidorConfirmada:null},accionesEnviadas:this.negotiation.repliesSent,
      accionesControlesEnviadas:0,accesoCuentaConfirmado:null,privacidad:'sin valores de entrada, cuerpos JSON, paquetes crudos ni credenciales',
      aviso:this.counts.frames?'La lectura describe controles recibidos; no confirma acceso a la cuenta.':'Todavia no se recibieron mensajes de interfaz nativa. El lector no solicita ni anuncia esa interfaz.'};
  }
}
module.exports={NativeUiDiagnostic,LIMITS};
