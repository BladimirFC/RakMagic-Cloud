'use strict';
// Equivalent matching and replay safeguards to Android LoginAutomation.
const normalize=value=>String(value??'').replace(/~n~/gi,' ').replace(/~[rgbypwsh]~/gi,'').replace(/\{[0-9a-f]{6}\}/gi,'').replace(/\s+/g,' ').trim();
const fingerprint=d=>d.style+'\0'+normalize(d.title)+'\0'+normalize(d.yes)+(d.style===1?'\0'+normalize(d.body):'');
const fold=value=>normalize(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function newIpDialog(dialog){
  return dialog?.style===3&&/^>{2,3}$/.test(normalize(dialog.yes))&&fold(dialog.no)==='salir'
    &&/^[#\[\]()\s]*newgamers juego de rol(?:\s+1)?[#\[\]()\s]*$/.test(fold(dialog.title))
    &&/^detectamos una nueva conexion ip\s*para continuar debes ingresar la clave con la que (?:te )?registraste\s*:$/.test(fold(dialog.body));
}
function newGamersHost(host){return /^(?:s1\.newgamers\.es\.?|15\.204\.150\.(?:150|190))$/i.test(String(host));}
function accountConfirmation(dialog){
  return dialog?.style===0&&fold(dialog.title)==='confirmar cuenta'&&fold(dialog.yes)==='si, es mia';
}
function accountPassword(dialog){
  if(dialog?.style!==3||newIpDialog(dialog))return false;
  const title=fold(dialog.title),body=fold(dialog.body),yes=fold(dialog.yes);
  if(/registr|recuper|restablec|cambiar|nueva (?:clave|contrasena)/.test(title+' '+body))return false;
  return /^(?:entrar|ingresar|acceder|continuar|siguiente|iniciar|iniciar sesion|conectar|aceptar|>{2,3})$/.test(yes)
    &&(/contrasena|\bclave\b|password/.test(title)
      ||/newgamers|iniciar sesion|identificacion|^acceso(?:\s|$)|^login$|^ingreso$/.test(title)
        &&/(?:introduce|introduzca|ingresa|ingrese|ingresar|escribe|escriba|coloca|digita).{0,100}(?:clave|contrasena|password)/.test(body));
}
class Automation {
  constructor(steps,driver,now=Date.now(),options={}) {
    this.steps=steps.map(s=>({...s,text:normalize(s.text),title:normalize(s.title),yes:normalize(s.yes),body:normalize(s.body)}));
    this.driver=driver;this.completed=0;this.active=true;this.started=now;this.lastAttempt=-Infinity;this.connected=false;this.attempt=false;
    this.dialogs=new Set();this.credentials=new Set();this.clicked=new Set();this.busy=false;this.failed=false;
    this.newIpVerification=options.newIpVerification===true;this.newIpAttempted=false;
    this.newIpPassword=typeof options.newIpPassword==='string'?options.newIpPassword:'';
    this.flexibleLogin=options.flexibleLogin===true;this.confirmationSent=false;this.livePasswordSerial=null;
  }
  stop(reason,failed=true){this.active=false;this.failed=failed;return reason;}
  reopened(s){return s.state===3&&s.dialog&&!this.dialogs.has(s.dialog.serial)&&this.credentials.has(fingerprint(s.dialog));}
  async pump(s,now=Date.now()) {
    if(this.busy)return null;
    if(this.failed)return null;
    if(s.state===3&&this.newIpVerification&&newIpDialog(s.dialog)){
      const dialog=s.dialog;
      if(this.dialogs.has(dialog.serial))return null;
      if(this.newIpAttempted)return this.stop('El servidor volvio a pedir la verificacion de IP; acceso suspendido.');
      const expected=this.steps[this.completed];
      const recorded=expected?.kind==='dialog'&&expected.style===dialog.style&&expected.title===normalize(dialog.title)&&expected.yes===normalize(dialog.yes)
        &&(!expected.body||expected.body===normalize(dialog.body)||newIpDialog({...expected,no:dialog.no}));
      if(recorded&&(!expected.accepted||expected.item!==-1||!expected.value))return this.stop('El perfil no contiene una respuesta aceptada para la verificacion de IP.');
      const keys=this.newIpPassword?new Set([this.newIpPassword]):recorded?new Set([expected.value]):new Set(this.steps.filter(step=>step.kind==='dialog'&&[1,3].includes(step.style)&&step.accepted&&step.value).map(step=>step.value));
      if(keys.size!==1)return this.stop('Falta una clave unica para verificar la nueva IP. Configura RAKMAGIC_NEW_IP_PASSWORD en .env y usa desconectar y recargar.');
      if(now-this.lastAttempt<500)return null;
      this.busy=true;this.lastAttempt=now;this.newIpAttempted=true;
      try{
        if(!await this.driver.reply(dialog.serial,dialog.id,true,-1,keys.values().next().value))return this.stop('No se pudo confirmar el envio de la verificacion de IP; acceso suspendido.');
        if(s.state!==3)return this.stop('Conexion perdida durante la verificacion de IP.',false);
        this.dialogs.add(dialog.serial);this.credentials.add(fingerprint(dialog));this.clicked.clear();
        if(s.dialog?.serial===dialog.serial)s.dialog=null;
        this.started=now;
        if(recorded){this.completed++;if(this.completed===this.steps.length)this.active=false;}
        return 'Verificacion por nueva IP enviada una vez; continuando el recorrido grabado.';
      }catch(_){return this.stop('No se pudo confirmar el envio de la verificacion de IP; acceso suspendido.');}
      finally{this.busy=false;}
    }
    if(this.reopened(s))return this.stop('El servidor volvio a pedir las credenciales; reconexion suspendida.');
    if(!this.active)return null;
    if(s.state!==0)this.attempt=true;
    if(s.state===0&&this.attempt||this.connected&&s.state!==3)return this.stop('Conexion perdida durante el acceso.',false);
    if(!this.connected&&s.state===3)this.started=now;
    if(now-this.started>=120000)return this.stop('No aparecio el paso esperado; revisa el login en el movil.');
    if(s.state!==3)return null;
    this.connected=true;
    let step=this.steps[this.completed];const dialog=s.dialog;
    if(dialog){
      if(this.dialogs.has(dialog.serial))return null;
      const same=step.kind==='dialog'&&dialog.style===step.style&&normalize(dialog.title)===step.title&&normalize(dialog.yes)===step.yes;
      if(this.flexibleLogin&&accountConfirmation(dialog)&&!same){
        if(this.confirmationSent)return this.stop('El servidor repitio la confirmacion de cuenta; acceso suspendido.');
        if(now-this.lastAttempt<500)return null;
        this.busy=true;this.lastAttempt=now;this.confirmationSent=true;
        try{
          if(!await this.driver.reply(dialog.serial,dialog.id,true,-1,''))return this.stop('No se pudo enviar la confirmacion de cuenta.');
          if(s.state!==3)return this.stop('Conexion perdida durante la confirmacion de cuenta.',false);
          this.dialogs.add(dialog.serial);this.clicked.clear();if(s.dialog?.serial===dialog.serial)s.dialog=null;
          this.started=now;return 'Cuenta confirmada; continuando el acceso grabado.';
        }catch(_){return this.stop('No se pudo enviar la confirmacion de cuenta.');}
        finally{this.busy=false;}
      }
      if(this.flexibleLogin&&!same&&accountPassword(dialog)){
        // A server can open the password directly instead of requiring the
        // recorded textdraw first. Reuse only an unambiguous recorded secret.
        const candidates=this.steps.map((value,index)=>({value,index})).filter(({value,index})=>index>=this.completed&&value.kind==='dialog'&&value.style===3&&value.accepted&&value.item===-1&&value.value);
        if(candidates.length&&new Set(candidates.map(v=>v.value.value)).size===1){
          this.completed=candidates[0].index;step=candidates[0].value;this.livePasswordSerial=dialog.serial;
        }
      }
      const livePassword=this.livePasswordSerial===dialog.serial&&accountPassword(dialog)&&step.kind==='dialog'&&step.style===3;
      const dynamicBody=this.flexibleLogin&&same&&(accountConfirmation(dialog)||dialog.style===3);
      if(!livePassword&&(step.kind!=='dialog'||dialog.style!==step.style||normalize(dialog.title)!==step.title||normalize(dialog.yes)!==step.yes||step.body&&!dynamicBody&&normalize(dialog.body)!==step.body))
        return this.stop('Aparecio un dialogo distinto del grabado; reconexion suspendida.');
    }
    if(now-this.lastAttempt<500)return null;
    let action;
    switch(step.kind){
      case 'textdraw': {
        if(!s.selecting)return null;
        const namedLogin=this.flexibleLogin&&/^(?:entrar|ingresar|acceder|iniciar sesion|contrasena|clave|password|jugar)$/.test(fold(step.text));
        const candidates=Array.from(s.textdraws.values()).filter(td=>td.selectable&&td.style===step.style
          &&(normalize(td.text)===step.text||namedLogin&&fold(td.text)===fold(step.text)));
        let matches=candidates.filter(td=>Math.abs(td.x-step.x)<=2&&Math.abs(td.y-step.y)<=2);
        // Named login controls may move when the server changes its layout.
        // Sprite-only or ambiguous controls keep their recorded coordinates.
        if(!matches.length&&this.flexibleLogin&&/^(?:entrar|ingresar|acceder|iniciar sesion|contrasena|clave|password|jugar)$/.test(fold(step.text))&&candidates.length===1)matches=candidates;
        if(matches.length>1)return this.stop('Hay varios botones iguales al grabado; revisa el perfil.');
        if(!matches.length)return null;
        const td=matches[0],version=td.id+':'+td.revision;
        if(this.clicked.has(version))return null;
        action=async()=>{if(!await this.driver.click(td.id,td.revision))return false;this.clicked.add(version);return true;};break;
      }
      case 'dialog': {
        if(!dialog)return null;
        let item=step.item,value=step.value;
        if([2,4,5].includes(step.style)){
          if(!step.accepted&&item===-1)value='';
          else {
            const rows=String(dialog.body).split('\n'),offset=step.style===5?1:0;
            const matches=[];
            rows.forEach((row,index)=>{const label=row.split('\t')[0];if(index>=offset&&row&&normalize(label)===normalize(step.value))matches.push({item:index-offset,value:label});});
            if(!normalize(step.value)||matches.length!==1)return this.stop('La opcion del dialogo cambio; revisa el perfil.');
            ({item,value}=matches[0]);
          }
        }else if(item!==-1)return this.stop('Respuesta del dialogo no valida.');
        action=async()=>{
          if(!await this.driver.reply(dialog.serial,dialog.id,step.accepted,item,value))return false;
          this.dialogs.add(dialog.serial);
          if(step.accepted&&(step.style===3||step.style===1&&step.value))this.credentials.add(fingerprint(dialog));
          this.clicked.clear();if(s.dialog?.serial===dialog.serial)s.dialog=null;return true;
        };break;
      }
      case 'send':if(now-this.lastAttempt<2100)return null;action=()=>this.driver.send(step.value);break;
      case 'spawn':action=()=>this.driver.spawn();break;
      case 'cancelSelection':if(!s.selecting)return null;action=()=>this.driver.cancelSelection();break;
      default:return this.stop('Paso no valido.');
    }
    this.busy=true;this.lastAttempt=now;
    try {
      if(!await action())return null;
      if(s.state!==3)return this.stop('La conexion cambio durante el acceso.',false);
      this.completed++;this.started=now;
      if(this.completed===this.steps.length)return this.stop('Login grabado enviado; esperando la autorizacion del servidor.',false);
      return 'Acceso: paso '+this.completed+'/'+this.steps.length;
    }catch(_){return this.stop('No se pudo enviar el paso del acceso.');}
    finally{this.busy=false;}
  }
}
module.exports={Automation,normalize,newIpDialog,newGamersHost,accountConfirmation,accountPassword,fold};
