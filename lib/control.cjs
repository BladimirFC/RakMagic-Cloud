'use strict';
const {validNickname}=require('./accounts.cjs');
const actions=new Set(['connect','disconnect','afk-on','afk-off','account-connect']);

// Fixed account actions only. No console, game chat or file API.
class HostControl {
  constructor(getClient,enqueue,now=Date.now){this.getClient=getClient;this.enqueue=enqueue;this.now=now;this.requests=new Map();this.lastAction=-Infinity;}
  status(){
    const client=this.getClient();
    if(client?.getControlStatus)return client.getControlStatus();
    return {v:1,serverMenus:!!this.menus,accountMap:!!this.map,available:!!client&&!client.worker.closed,connecting:client?.connecting===true,desired:client?.desired===true,accountSelection:typeof client?.connectAccount==='function',accounts:client?.accountNames||[],session:client?client.status():null};
  }
  execute(body){
    const named=body&&Object.hasOwn(body,'nickname');
    if(!body||Array.isArray(body)||!Object.hasOwn(body,'id')||!Object.hasOwn(body,'action')||typeof body.id!=='string'||!body.id.match(/^[A-Za-z0-9_-]{16,64}$/)||!actions.has(body.action)||Object.keys(body).length!==(named?3:2)||body.action==='account-connect'&&!named||named&&!validNickname(body.nickname))return Promise.resolve({code:400,body:{ok:false,message:'Accion de control no valida.'}});
    const now=this.now();
    for(const [id,entry] of this.requests)if(entry.expires<=now)this.requests.delete(id);
    const previous=this.requests.get(body.id);
    if(previous)return previous.action===body.action&&previous.nickname===body.nickname?previous.result:Promise.resolve({code:409,body:{ok:false,message:'Identificador ya utilizado para otra accion.'}});
    if(this.requests.size>=128||now-this.lastAction<2100)return Promise.resolve({code:429,body:{ok:false,message:'Espera unos segundos antes de enviar otra accion.'}});
    this.lastAction=now;
    const result=this.enqueue(async()=>{
      const client=this.getClient();
      if(client?.getControlStatus){
        let message;
        if(body.action==='account-connect'||body.action==='connect'){
          const nickname=body.nickname??client.selected;
          if(!await client.connectAccount(nickname))throw Error('UNCONFIRMED');
          message='Conexion solicitada para '+nickname+'. Las demas cuentas siguen conectadas.';
        }else if(body.action==='disconnect'){
          await client.disconnectAccount(body.nickname);message='Cuenta desconectada; su reconexion automatica queda desactivada.';
        }else{
          const wanted=body.action==='afk-on';await client.setAccountAfk(body.nickname,wanted);
          message=wanted?'AFK solicitado para esa cuenta; esperando el acceso y el cierre de menus.':'AFK desactivado para esa cuenta.';
        }
        return {code:200,body:{ok:true,message,status:this.status()}};
      }
      if(named&&body.action!=='account-connect')return {code:409,body:{ok:false,message:'Actualiza el hosting para controlar varias cuentas.'}};
      if(!client||client.worker.closed)return {code:503,body:{ok:false,message:'El perfil o el cliente del hosting no esta preparado.'}};
      let message;
      if(body.action==='account-connect'){
        if(typeof client.connectAccount!=='function'||!await client.connectAccount(body.nickname))return {code:409,body:{ok:false,message:'No se pudo confirmar el cambio de cuenta. Consulta el estado.',status:this.status()}};
        message='Cuenta seleccionada: '+body.nickname+'. Consulta el estado para confirmar que termine el acceso.';
      }else if(body.action==='connect'){
        if(client.connecting||client.snapshot.state!==0)message='Ya hay una conexion en curso o activa.';
        else if(await client.connect())message='Conexion iniciada; esperando el acceso del servidor.';
        else return {code:409,body:{ok:false,message:'No se pudo iniciar la conexion. Consulta el estado.',status:this.status()}};
      }else if(body.action==='disconnect'){
        if(await client.disconnect()===false)throw Error('UNCONFIRMED');message='Desconexion solicitada. La reconexion automatica queda desactivada.';
      }else{
        const wanted=body.action==='afk-on';if(await client.setAfk(wanted)===false)throw Error('UNCONFIRMED');
        message=wanted?'AFK solicitado; se activara al terminar el acceso y cerrar los menus.':'Desactivacion de AFK solicitada.';
      }
      return {code:200,body:{ok:true,message,status:this.status()}};
    }).catch(error=>{
      if(['account-limit','memory-limit','target-required','account-offline','invalid-account','unavailable'].includes(error.code))return {code:409,body:{ok:false,error:error.code,message:error.message,status:this.status()}};
      return {code:500,body:{ok:false,message:'No se pudo confirmar la accion. Actualiza el estado antes de volver a intentarlo.'}};
    });
    this.requests.set(body.id,{action:body.action,nickname:body.nickname,result,expires:now+10*60000});return result;
  }
}
module.exports={HostControl};
