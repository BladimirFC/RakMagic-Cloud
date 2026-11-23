'use strict';
const {fold,accountConfirmation,accountPassword,newIpDialog,newGamersHost}=require('./automation.cjs');
const NICK='[A-Za-z0-9_\\[\\]().$=@]{3,24}';
class RecordedAccess {
  constructor(profile,worker,snapshot,now=Date.now){
    this.profile=profile;this.worker=worker;this.snapshot=snapshot;this.now=now;
    this.secrets=new Set(profile.steps.filter(s=>s.kind==='dialog'&&s.accepted&&[1,3].includes(s.style)&&s.value).map(s=>s.value));
    this.failure='';this.identity=false;this.confirmSerial=null;this.characters=0;this.characterChosen=false;this.playSent=false;this.spawnRequested=false;
    this.passwordAttempted=false;this.passwordSent=false;this.passwordSerial=null;this.passwordPending=false;
    this.ipAttempted=false;this.ipSent=false;this.postPasswordSpawn=false;this.proofAt=0;
    if(!newGamersHost(profile.host))this.failure='El acceso grabado protegido solo esta preparado para NewGamers.';
    if(!this.secrets.size)this.failure='El perfil no contiene una clave de acceso grabada. Envialo otra vez desde RakMagic.';
  }
  deny(reason){this.failure=this.failure||reason;throw Error('RECORDED_ACCESS_STOPPED');}
  passwordDialog(d){
    if(accountPassword(d))return true;
    return d&&[1,3].includes(d.style)&&!newIpDialog(d)
      &&!/registr|recuper|restablec|cambiar|nueva (?:clave|contrasena)/.test(fold(d.title)+' '+fold(d.body))
      &&this.profile.steps.some(s=>s.kind==='dialog'&&s.accepted&&s.value&&s.style===d.style
        &&fold(s.title)===fold(d.title)&&fold(s.yes)===fold(d.yes));
  }
  usable(){if(this.failure||this.worker.closed||this.snapshot().state!==3)this.deny('La conexion cambio durante el acceso grabado.');}
  async perform(action){
    try{if(!await action())this.deny('No se pudo confirmar el envio de un paso; acceso detenido sin reintentar.');return true;}
    catch(_){this.failure=this.failure||'No se pudo confirmar el envio de un paso; acceso detenido sin reintentar.';throw Error('RECORDED_ACCESS_STOPPED');}
  }
  observe(event){
    if(event.type==='spawnStatus'&&event.text==='Spawn enviado con la ubicacion del servidor.'&&(this.passwordSent||this.passwordPending)){
      this.postPasswordSpawn=true;this.proofAt=this.now();
    }
    if(event.type==='dialog'&&this.passwordAttempted&&this.passwordDialog(event)&&event.serial!==this.passwordSerial)
      this.failure=this.failure||'El servidor volvio a pedir la clave; acceso detenido sin volver a enviarla.';
    if(event.type==='dialog'&&this.identity&&accountConfirmation(event)&&event.serial!==this.confirmSerial)
      this.failure=this.failure||'El servidor repitio la confirmacion de cuenta; acceso detenido.';
  }
  async reply(serial,id,yes,item,value){
    this.usable();const d=this.snapshot().dialog;
    if(!d||d.serial!==serial||d.id!==id||!yes)this.deny('El dialogo ya no coincide con el paso de acceso.');
    if(accountConfirmation(d)){
      const body=fold(d.body),user=body.match(new RegExp('(?:^|\\s)usuario:\\s*('+NICK+')(?=\\s|$)','i'));
      const character=body.match(new RegExp('entraste con el personaje\\s+('+NICK+')(?=,|\\s|$)','i'));
      if(this.identity||!user||user[1]!==fold(this.profile.nickname)||character&&character[1]!==fold(this.profile.nickname))
        this.deny('La cuenta de la confirmacion no coincide con la cuenta seleccionada.');
      if(item!==-1||value!=='')this.deny('La respuesta grabada de confirmacion de cuenta no es valida.');
      const count=body.match(/\bpersonajes:\s*(\d+)/);this.characters=count?Number(count[1]):0;
      await this.perform(()=>this.worker.reply(serial,id,true,item,value));
      this.identity=true;this.confirmSerial=serial;return true;
    }
    const ip=newIpDialog(d),password=this.passwordDialog(d);
    if(ip||password){
      if(item!==-1||typeof value!=='string'||!value||!(this.secrets.has(value)||ip&&value===this.profile.newIpPassword))
        this.deny('El campo no tiene una clave grabada valida para este acceso.');
      if(ip){if(this.ipAttempted)this.deny('La verificacion de IP ya se intento en esta conexion.');this.ipAttempted=true;}
      else{
        if(!this.identity)this.deny('Falta confirmar la identidad de la cuenta antes de enviar la clave.');
        if(this.passwordAttempted)this.deny('La clave ya se intento en esta conexion.');
        this.passwordAttempted=true;this.passwordSerial=serial;this.passwordPending=true;
      }
      this.postPasswordSpawn=false;this.proofAt=0;
      try{await this.perform(()=>this.worker.reply(serial,id,true,item,value));if(ip)this.ipSent=true;else this.passwordSent=true;return true;}
      finally{this.passwordPending=false;}
    }
    if(this.identity&&this.passwordSent&&[2,4,5].includes(d.style)&&fold(value).replace(/\s/g,'_')===fold(this.profile.nickname)){
      await this.perform(()=>this.worker.reply(serial,id,true,item,value));this.characterChosen=true;return true;
    }
    this.deny('El dialogo no es una confirmacion, clave o seleccion del personaje reconocido.');
  }
  async click(id,revision){
    this.usable();const td=this.snapshot().textdraws.get(id);
    if(!this.identity||!td||td.revision!==revision||!td.selectable)this.deny('El boton de acceso ya no coincide con la pantalla actual.');
    if(this.passwordSent&&this.characters!==1){
      if(fold(td.text).replace(/\s/g,'_')===fold(this.profile.nickname))this.characterChosen=true;
      else if(!this.characterChosen||!/^(?:jugar|continuar|entrar|acceder)$/.test(fold(td.text)))
        this.deny('No se pudo verificar que el boton corresponde al personaje seleccionado.');
    }
    const play=this.passwordSent&&fold(td.text)==='jugar';
    if(play&&this.playSent)this.deny('Jugar ya se envio en esta conexion.');
    await this.perform(()=>this.worker.click(id,revision));if(play)this.playSent=true;return true;
  }
  async spawn(){
    this.usable();if(!this.passwordSent||(this.characters!==1&&!this.characterChosen))this.deny('Falta verificar la clave y el personaje antes de solicitar aparecer.');
    if(this.spawnRequested)this.deny('La aparicion ya se solicito en esta conexion.');
    this.spawnRequested=true;
    try{if(await this.worker.spawn()||this.postPasswordSpawn)return true;}
    catch(_){}
    this.deny('No se pudo confirmar la solicitud de aparicion; acceso detenido sin reintentar.');
  }
  async cancelSelection(){this.usable();if(!this.passwordSent)this.deny('Falta enviar la clave antes de cerrar la seleccion.');return this.perform(()=>this.worker.cancelSelection());}
  async send(){this.deny('Esta prueba usa dialogos y botones; no envia claves mediante comandos de chat.');}
  confirmed(completed,total,spawned){
    const s=this.snapshot();return !this.failure&&this.identity&&this.passwordSent&&this.postPasswordSpawn
      &&this.now()-this.proofAt>=1000&&(this.characters===1||this.characterChosen)
      &&completed===total&&total>0&&s.state===3&&spawned&&!s.dialog&&!s.selecting;
  }
  report(){return {cuentaConfirmada:this.identity,claveIntentada:this.passwordAttempted,claveEnviada:this.passwordSent,
    verificacionIpEnviada:this.ipSent,aparicionPosteriorClave:this.postPasswordSpawn,personajes:this.characters,
    personajeElegido:this.characterChosen,botonJugarEnviado:this.playSent,solicitudAparicionIntentada:this.spawnRequested,motivoDetencion:this.failure};}
}
module.exports={RecordedAccess};
