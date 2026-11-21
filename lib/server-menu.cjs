'use strict';
const crypto=require('node:crypto');
const {redact}=require('./profile.cjs');
const {validNickname}=require('./accounts.cjs');
const {encode,decoder}=require('./encoding.cjs');
const fields=new Set(['flags','style','model','color','boxColor','background','shadow','outline','lx','ly','tx','ty','x','y']);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class MenuError extends Error {constructor(code,message){super(message);this.code=code;}}
class ServerMenu {
  constructor(client){this.client=client;this.selection=0;this.lastAction=0;this.reset();}
  reset(){this.epoch=crypto.randomUUID();this.owner=null;this.lease=null;this.expires=0;this.resumed=false;this.pauseRequested=false;this.lastAction=0;this.selection++;}
  expire(){if(this.lease&&Date.now()>=this.expires){if(this.resumed)this.pauseRequested=true;this.owner=null;this.lease=null;this.resumed=false;}}
  get holding(){this.expire();return !!this.lease;}
  ready(){const c=this.client;return !c.worker.closed&&c.snapshot.state===3&&c.accessCompleted&&!c.blocked&&!c.market?.active&&!c.vehicleTrial?.holding;}
  clean(value,max=1024){return redact(String(value??''),this.client.profile).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,max);}
  observe(event){if(event.type==='selectTextdraw')this.selection++;if(event.type==='state'&&event.state<=1)this.reset();}
  view(lease){
    this.expire();const c=this.client,s=c.snapshot,owned=!!lease&&lease===this.lease;
    if(owned)this.expires=Date.now()+45000;
    const values=[...s.textdraws.values()].sort((a,b)=>Number(b.selectable)-Number(a.selectable)||a.id-b.id),d=s.dialog;
    const draws=values.slice(0,512).map(td=>{
      const value={id:td.id,revision:td.revision,selectable:!!td.selectable,text:this.clean(td.text)};
      for(const key of fields)if(Number.isFinite(td[key]))value[key]=td[key];return value;
    }).sort((a,b)=>a.id-b.id);
    return {v:1,supported:true,account:c.profile.nickname,state:s.state,epoch:this.epoch,ready:this.ready(),afk:!!c.paused,afkWanted:!!c.afkWanted,
      manual:owned,busy:!!this.lease&&!owned,selection:this.selection,selecting:!!s.selecting,truncated:values.length>512,textdraws:draws,
      dialog:d?{id:d.id,serial:d.serial,style:d.style,title:this.clean(d.title,255),yes:this.clean(d.yes,255),no:this.clean(d.no,255),body:this.clean(d.body,8192)}:null,
      message:c.accessRejection||(!this.ready()?'El control manual se habilita al completar el acceso de esta cuenta.':owned?'Control manual activo. Al volver se restaura AFK si esta solicitado.':'Puedes tomar el control de los menus de esta cuenta.')};
  }
  own(body){
    this.expire();
    if(body.epoch!==this.epoch)throw new MenuError('stale-screen','La cuenta se reconecto. Actualiza la pantalla antes de responder.');
    if(!this.ready())throw new MenuError('not-ready','Espera a que esta cuenta complete su acceso.');
    if(!this.lease||body.lease!==this.lease)throw new MenuError('lease-expired','El control manual vencio. Vuelve a tomar el control.');
    this.expires=Date.now()+45000;
  }
  begin(body){
    if(body.epoch!==this.epoch)throw new MenuError('stale-screen','La cuenta cambio. Actualiza la pantalla.');
    if(!this.ready())throw new MenuError('not-ready','Espera a que esta cuenta complete su acceso.');
    this.expire();
    if(this.lease&&this.owner!==body.viewer)throw new MenuError('menu-busy','Otra pantalla controla los menus de esta cuenta. Espera a que se cierre.');
    if(!this.lease){this.owner=body.viewer;this.lease=crypto.randomBytes(24).toString('base64url');this.resumed=false;this.pauseRequested=false;}
    this.expires=Date.now()+45000;return this.lease;
  }
  async awaken(body){
    this.own(body);
    if(!this.resumed){
      if(!await this.client.worker.command('pause',0))throw new MenuError('unconfirmed','No se confirmo la reanudacion de esta cuenta.');
      this.client.paused=false;this.resumed=true;await wait(2100);this.own(body);
    }
    if(Date.now()-this.lastAction<2100)throw new MenuError('cooldown','Espera dos segundos antes de otra accion del servidor.');
  }
  async execute(body){
    if(body.action==='begin')return {lease:this.begin(body),message:'Control manual preparado.'};
    this.own(body);
    if(body.action==='end'){if(this.resumed)this.pauseRequested=true;this.owner=null;this.lease=null;this.resumed=false;return {message:'Control soltado. La cuenta sigue conectada; se restaura AFK si esta solicitado.'};}
    await this.awaken(body);const c=this.client,s=c.snapshot;
    let ok=false;
    if(body.action==='command'){
      if(s.dialog||s.selecting)throw new MenuError('menu-open','Cierra el menu actual antes de enviar otro comando.');
      this.lastAction=Date.now();ok=await c.worker.send(body.command);
    }else if(body.action==='click'){
      const td=s.textdraws.get(body.textdraw);
      if(s.dialog||!s.selecting||!td?.selectable||td.revision!==body.revision)throw new MenuError('stale-screen','El boton cambio. Actualiza la pantalla antes de pulsarlo.');
      this.lastAction=Date.now();ok=await c.worker.click(body.textdraw,body.revision);
    }else if(body.action==='cancel'){
      if(s.dialog||!s.selecting||this.selection!==body.selection)throw new MenuError('stale-screen','La seleccion cambio. Actualiza la pantalla.');
      this.lastAction=Date.now();ok=await c.worker.cancelSelection();
    }else if(body.action==='dialog'){
      const d=s.dialog;
      if(!d||d.serial!==body.serial||d.id!==body.dialog)throw new MenuError('stale-screen','El dialogo cambio. Actualiza antes de responder.');
      let item=-1,value='';
      if(body.accepted){
        if([1,3].includes(d.style))value=body.value;
        else if([2,4,5].includes(d.style)){
          const rows=String(d.body).replace(/\r/g,'').split('\n'),offset=d.style===5?1:0;
          if(rows.at(-1)==='')rows.pop();item=body.item;
          if(item<0||item+offset>=rows.length)throw new MenuError('invalid-option','Selecciona una opcion de la lista actual.');
          value=rows[item+offset].split('\t')[0];
        }
      }
      if(encode(value).length>255||decoder.decode(encode(value))!==value||/[\x00-\x1f\x7f]/.test(value))throw new MenuError('invalid-text','La respuesta supera el limite o contiene caracteres que el juego no admite.');
      this.lastAction=Date.now();ok=await c.worker.reply(d.serial,d.id,body.accepted,item,value);
      if(ok&&s.dialog?.serial===d.serial)s.dialog=null;
    }
    if(!ok)throw new MenuError('unconfirmed','No se confirmo el envio. Actualiza la pantalla antes de repetir la accion.');
    if(body.epoch!==this.epoch)throw new MenuError('stale-screen','La conexion cambio durante la accion.');
    return {message:'Accion enviada al servidor. Esperando su respuesta.'};
  }
}
class ServerMenuControl {
  constructor(getManager,enqueue){this.getManager=getManager;this.enqueue=enqueue;this.requests=new Map();this.secret=crypto.randomBytes(32);}
  target(nickname){
    if(!validNickname(nickname))throw new MenuError('invalid-account','Selecciona una cuenta valida.');
    const client=this.getManager()?.target(nickname);
    if(!client?.serverMenu||client.worker.closed)throw new MenuError('account-offline','Esa cuenta esta desconectada.');return client.serverMenu;
  }
  screen(nickname,lease){return this.target(nickname).view(lease);}
  valid(body){
    if(!body||Array.isArray(body)||typeof body.id!=='string'||!/^[A-Za-z0-9_-]{16,64}$/.test(body.id)||!validNickname(body.nickname)||typeof body.epoch!=='string'||body.epoch.length>64)return false;
    if(typeof body.action!=='string'||!['begin','end','command','click','cancel','dialog'].includes(body.action))return false;
    const extra={begin:['viewer'],end:['lease'],command:['lease','command'],click:['lease','textdraw','revision'],cancel:['lease','selection'],dialog:['lease','serial','dialog','accepted','item','value']}[body.action];
    if(!extra||Object.keys(body).length!==4+extra.length||!['id','nickname','epoch','action',...extra].every(key=>Object.hasOwn(body,key)))return false;
    if(body.action==='begin')return typeof body.viewer==='string'&&/^[A-Za-z0-9_-]{16,64}$/.test(body.viewer);
    if(typeof body.lease!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(body.lease))return false;
    if(body.action==='command')return typeof body.command==='string'&&/^\/[^\x00-\x1f\x7f]+$/.test(body.command)&&encode(body.command).length<=512&&decoder.decode(encode(body.command))===body.command;
    if(body.action==='click')return Number.isInteger(body.textdraw)&&body.textdraw>=0&&body.textdraw<2304&&Number.isSafeInteger(body.revision)&&body.revision>0;
    if(body.action==='cancel')return Number.isSafeInteger(body.selection)&&body.selection>=0;
    if(body.action==='dialog')return Number.isSafeInteger(body.serial)&&body.serial>=0&&Number.isInteger(body.dialog)&&body.dialog>=0&&body.dialog<=32767&&typeof body.accepted==='boolean'&&Number.isInteger(body.item)&&body.item>=-1&&body.item<=4095&&typeof body.value==='string'&&body.value.length<=1024;
    return true;
  }
  execute(body){
    if(!this.valid(body))return Promise.resolve({code:400,body:{ok:false,message:'Accion de menu no valida.'}});
    const now=Date.now();for(const [id,entry] of this.requests)if(entry.expires<=now)this.requests.delete(id);
    const signature=crypto.createHmac('sha256',this.secret).update(JSON.stringify(body)).digest('hex'),old=this.requests.get(body.id);
    if(old)return old.signature===signature?old.result:Promise.resolve({code:409,body:{ok:false,message:'Identificador reutilizado para otra accion.'}});
    if(this.requests.size>=128)return Promise.resolve({code:429,body:{ok:false,message:'Espera unos segundos antes de otra accion.'}});
    const result=this.enqueue(async()=>{
      const menu=this.target(body.nickname),reply=await menu.execute(body);
      return {code:200,body:{v:1,ok:true,...reply,screen:menu.view(reply.lease||body.lease)}};
    }).catch(error=>({code:error.code==='cooldown'?429:409,body:{ok:false,error:error instanceof MenuError?error.code:'unconfirmed',message:error instanceof MenuError?error.message:'No se confirmo la accion. Actualiza antes de repetirla.'}}));
    this.requests.set(body.id,{signature,result,expires:now+60000});return result;
  }
}
module.exports={ServerMenu,ServerMenuControl,MenuError};
