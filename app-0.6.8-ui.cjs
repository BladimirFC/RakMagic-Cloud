'use strict';
const fs=require('node:fs');
const path=require('node:path');
const dns=require('node:dns').promises;
const readline=require('node:readline');
const {EventEmitter}=require('node:events');
const {Worker}=require('./lib/worker-ui-0.6.6.cjs');
const {WireGuard}=require('./lib/wireguard.cjs');
const {workerPath,prepareWorker}=require('./lib/native-binary-ui-0.6.6.cjs');
const {ConnectionDiagnostic}=require('./lib/connection-diagnostic.cjs');
const {LoginTrace}=require('./lib/login-trace.cjs');
const {AdminKickCooldown}=require('./lib/admin-kick-cooldown-ui-0.6.6.cjs');
const {Automation,normalize,newGamersHost}=require('./lib/automation.cjs');
const {identity,decryptProfile,redact}=require('./lib/profile.cjs');
const {wire}=require('./lib/encoding.cjs');
const {newIpPassword}=require('./lib/config.cjs');
const {parseEnv}=require('node:util');
const {MarketScanner,schedule,validateButton}=require('./lib/market.cjs');
const {MarketFeed,serveFeed}=require('./lib/market-feed-0.6.0.cjs');
const {HostControl}=require('./lib/control.cjs');
const {validNickname,readChoice,saveChoice}=require('./lib/accounts.cjs');
const {SessionManager}=require('./lib/sessions-ui-0.6.6.cjs');
const {AccountMap}=require('./lib/account-map-0.6.0.cjs');
const {ServerMenu,ServerMenuControl}=require('./lib/server-menu-0.6.0.cjs');
const {VehicleDiagnostic,VehicleGate,vehicleCommand}=require('./lib/vehicle-diagnostic.cjs');
function inWindow(settings,date=new Date()){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:settings.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const minute=Number(parts.find(p=>p.type==='hour').value)*60+Number(parts.find(p=>p.type==='minute').value);
  return settings.start<settings.end?minute>=settings.start&&minute<settings.end:minute>=settings.start||minute<settings.end;
}
class CloudClient extends EventEmitter {
  constructor(worker,directory,profile,{restoreAccountChoice=true,afkOnly=false,diagnosticOnly=false}={}){
    super();this.worker=worker;this.directory=directory;this.profile=profile;
    this.diagnosticOnly=diagnosticOnly;
    this.afkOnly=afkOnly;this.spawnTryAt=0;this.spawnChecks=0;this.accessRejection='';this.accessCompleted=false;this.mapLocation=null;this.mapPositionSignature='';
    this.accountSource={host:profile.host,port:profile.port,nickname:profile.nickname};
    const choice=restoreAccountChoice?readChoice(directory,this.accountSource):null;
    this.accountNames=[...new Set([profile.nickname,...(choice?.names||[])].filter(validNickname))].slice(-30);
    if(choice)profile.nickname=choice.nickname;
    this.snapshot={state:0,selecting:false,dialog:null,textdraws:new Map()};
    this.spawned=false;this.paused=false;this.afkWanted=diagnosticOnly?false:profile.afk;this.desired=false;this.connecting=false;this.blocked=false;
    this.generation=0;this.sessionStart=0;this.attempts=0;this.nextRetry=0;this.lastReason='';this.chat=false;this.busy=false;
    this.stoppedDialog=null;
    this.market=null;this.marketEnabled=false;this.marketReadyAt=0;this.marketForce=false;
    this.connectionDiagnostic=new ConnectionDiagnostic();
    this.loginTrace=new LoginTrace(profile);
    this.reconnectCooldown=new AdminKickCooldown(directory,profile);
    this.serverMenu=new ServerMenu(this);
    this.onWorkerEvent=event=>this.event(event);
    this.onWorkerClosed=()=>{this.endSession('Cliente nativo detenido');this.snapshot.state=0;this.connecting=false;this.spawned=false;this.paused=false;this.blocked=true;if(!worker.stopping)this.notice('El cliente nativo termino. Vuelve a conectar esta cuenta para reintentarlo.');};
    worker.on('event',this.onWorkerEvent);worker.on('closed',this.onWorkerClosed);
  }
  dispose(){this.serverMenu.reset();this.vehicleTrial?.dispose();this.market?.reset();this.worker.removeListener('event',this.onWorkerEvent);this.worker.removeListener('closed',this.onWorkerClosed);}
  notice(text){this.emit('notice',redact(text,this.profile));}
  event(event){
    this.connectionDiagnostic.observe(event);
    this.loginTrace.observe(event);
    this.emit('nativeEvent',event); // Used only by the isolated integration test, no credential output.
    const s=this.snapshot;
    switch(event.type){
      case 'state':{
        const previous=s.state;s.state=event.state;this.lastReason=String(event.text||'');
        let administrativeKick=false;
        if(event.state===0&&previous!==0&&this.desired){
          try{administrativeKick=this.reconnectCooldown.disconnected(this.lastReason);}
          catch(error){
            this.blocked=true;this.desired=false;this.nextRetry=0;this.engine=null;
            this.notice(error.message);this.emit('connectionReviewRequired');
          }
        }
        if(administrativeKick){
          this.blocked=false;this.engine=null;this.connecting=false;
          this.nextRetry=this.reconnectCooldown.until;
          this.notice('Expulsion administrativa de esta cuenta detectada. No se intentara entrar durante 20 minutos; hasta '+new Date(this.nextRetry).toISOString()+'.');
        }
        const accessWasReady=previous===3&&(this.accessCompleted||this.spawned&&this.engine?.completed===this.profile.steps.length)&&!this.blocked;
        const preLoginClose=!administrativeKick&&event.state===0&&previous>=2&&this.desired&&event.text==='El servidor cerro la conexion'&&!accessWasReady;
        if(preLoginClose){
          this.loginTrace.closed({...s,state:previous},this.engine,this.spawned,true);
          if(s.dialog)this.stoppedDialog={...s.dialog};
          this.blocked=true;this.desired=false;this.nextRetry=0;
          this.engine?.stop?.('El servidor cerro la conexion antes de completar el acceso.',false);
          this.notice('El servidor cerro la conexion antes de completar el login. Reintentos pausados para esta cuenta; consulta su diagnostico de conexion.');
          this.emit('connectionReviewRequired');
        }
        if(event.state<=1){s.selecting=false;s.dialog=null;s.textdraws.clear();this.spawned=false;this.paused=false;this.accessCompleted=false;this.mapLocation=null;this.mapPositionSignature='';this.market?.reset();this.marketReadyAt=0;}
        if(event.state===3&&!this.sessionStart){this.sessionStart=Date.now();this.notice('Conexion de red preparada para '+this.profile.nickname+'. Acceso de cuenta pendiente.');}
        if(event.state===0&&previous!==0){
          this.endSession(this.lastReason);
          if(!administrativeKick&&this.desired&&this.profile.reconnect.enabled&&!this.blocked){this.nextRetry=Date.now()+[30000,60000,120000,240000,300000][Math.min(this.attempts++,4)];this.notice('Conexion perdida. Reintento dentro del horario configurado.');}
        }
        this.notice(event.state===3?'Servidor disponible: '+String(event.text||'').replace(/^Conectado:\s*/,''):event.text);break;
      }
      case 'workerStatus':{
        this.spawned=event.spawned;this.paused=event.paused;this.interior=event.interior;
        const p=event.mapPosition,revision=event.mapPositionRevision;
        if(event.state===3&&event.mapPositionKnown===true&&Number.isSafeInteger(revision)&&revision>0&&Array.isArray(p)&&p.length===3&&p.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100000)){
          const room=Number.isInteger(event.interior)&&event.interior>=0&&event.interior<=255?event.interior:null;
          const signature=revision+':'+room;
          if(signature!==this.mapPositionSignature){
            this.mapPositionSignature=signature;this.mapLocation={x:p[0],y:p[1],z:p[2],interior:room,updatedAt:new Date().toISOString()};
            if(this.accessCompleted&&!this.blocked)this.emit('mapLocation',this.mapLocation);
          }
        }
        break;
      }
      case 'textdraw':if(event.id>=0&&event.id<2304)s.textdraws.set(event.id,event);break;
      case 'hideTextdraw':s.textdraws.delete(event.id);break;
      case 'editTextdraw':if(s.textdraws.has(event.id))Object.assign(s.textdraws.get(event.id),{text:event.text,revision:event.revision});break;
      case 'selectTextdraw':s.selecting=event.enabled;break;
      case 'dialog':s.dialog=event;if(s.state>=2)this.reconnectCooldown.observe(redact(event.body,this.profile));break;
      case 'closeDialog':s.dialog=null;break;
      case 'spawnStatus':this.notice(event.text);break;
      case 'log':{
        const text=redact(event.text,this.profile),plain=normalize(text);
        if(s.state>=2)this.reconnectCooldown.observe(text);
        if(/IP.{0,100}(?:bloquead|Datacenter|VPS)|Razon IP|launcher.{0,80}obligatorio/i.test(plain)){
          this.accessRejection=(this.accessRejection+' '+plain).trim().slice(-1500);this.notice(plain);
        }
        this.market?.observeLog(text);if(this.chat)this.notice(text);break;
      }
      case 'workerError':this.blocked=true;this.notice('El cliente nativo recibio un comando no valido.');break;
    }
    this.serverMenu.observe(event);this.vehicleTrial?.observe(event);
  }
  endSession(reason){
    if(!this.sessionStart)return;
    const now=Date.now(),record={account:this.profile.nickname,host:this.profile.host,port:this.profile.port,start:new Date(this.sessionStart).toISOString(),end:new Date(now).toISOString(),durationSeconds:Math.max(0,Math.floor((now-this.sessionStart)/1000)),reason:redact(reason,this.profile)};
    this.sessionStart=0;
    try{
      const file=path.join(this.directory,'state/sessions.jsonl');
      fs.appendFileSync(file,JSON.stringify(record)+'\n',{mode:0o600});
    }catch(_){this.notice('No se pudo guardar el historial de esta sesion.');}
    this.emit('sessionEnded',record);
  }
  async connect(manual=true){
    if(this.connecting||this.snapshot.state!==0||this.worker.closed)return false;
    if(this.reconnectCooldown.remaining()>0){
      if(manual){this.desired=true;this.blocked=false;}
      this.nextRetry=this.reconnectCooldown.until;
      this.notice('Reconexiones pausadas por expulsion administrativa: quedan '+Math.ceil(this.reconnectCooldown.remaining()/1000)+' segundos.');
      return true;
    }
    if(manual){this.desired=true;this.blocked=false;this.attempts=0;this.stoppedDialog=null;}
    if(this.blocked)return false;
    this.connecting=true;this.nextRetry=0;
    const generation=++this.generation;
    try{
      const address=await dns.lookup(this.profile.host,{family:4});
      if(generation!==this.generation||!this.desired)return false;
      this.loginTrace.reset();this.reconnectCooldown.resetPending();
      this.serverMenu.reset();
      this.accessCompleted=false;this.mapLocation=null;this.mapPositionSignature='';
      this.accessRejection='';
      this.spawnTryAt=0;this.spawnChecks=0;
      await this.worker.command('autoSpawn',!this.diagnosticOnly&&this.profile.autoSpawn?1:0,wire(this.profile.loginMessage));
      this.engine=this.diagnosticOnly?null:new Automation(this.profile.steps,this.worker,Date.now(),{newIpVerification:newGamersHost(this.profile.host),newIpPassword:this.profile.newIpPassword,flexibleLogin:this.afkOnly&&newGamersHost(this.profile.host)});
      const ok=await this.worker.connect(address.address,this.profile.port,this.profile.nickname,this.profile.serverPassword);
      if(generation!==this.generation)return false;
      if(!ok)throw new Error('CONNECT_FAILED');
      this.notice(this.diagnosticOnly?'Diagnostico: login y AFK automaticos desactivados. Negociacion de interfaz solo por orden manual.':this.afkWanted?'Iniciando el acceso grabado; AFK se activara al aparecer.':'Iniciando el acceso grabado; AFK desactivado para esta cuenta.');return true;
    }catch(error){
      if(generation===this.generation){this.notice(error.code==='WIREGUARD'?error.message:'No se pudo iniciar la conexion.');if(this.desired&&this.profile.reconnect.enabled)this.nextRetry=Date.now()+[30000,60000,120000,240000,300000][Math.min(this.attempts++,4)];}
      return false;
    }finally{if(generation===this.generation)this.connecting=false;}
  }
  async negotiateUiInventory(){
    if(!this.diagnosticOnly||this.snapshot.state!==3||this.snapshot.dialog||this.worker.closed)return false;
    return this.worker.command('uiInventoryEmpty');
  }
  async disconnect(){
    this.serverMenu.reset();
    if(this.vehicleTrial?.holding)await this.vehicleTrial.stop('desconexion');
    this.market?.reset();this.marketReadyAt=0;
    this.desired=false;this.nextRetry=0;this.generation++;this.connecting=false;this.engine=null;
    this.endSession('Desconexion manual');return await this.worker.command('disconnect');
  }
  async connectAccount(nickname){
    if(!validNickname(nickname)||this.worker.closed)return false;
    if(nickname===this.profile.nickname&&(this.connecting||this.snapshot.state!==0))return true;
    if(this.connecting||this.snapshot.state!==0||this.desired){
      if(!await this.disconnect())return false;
      if(this.snapshot.state!==0){
        const offline=await new Promise(resolve=>{
          const changed=event=>{if(event.type==='state'&&event.state===0)finish(true);};
          const finish=ok=>{clearTimeout(timer);this.removeListener('nativeEvent',changed);resolve(ok);};
          const timer=setTimeout(()=>finish(false),2000);this.on('nativeEvent',changed);
          if(this.snapshot.state===0)finish(true);
        });
        if(!offline)return false;
      }
    }
    this.accountNames=saveChoice(this.directory,this.accountSource,nickname,this.accountNames);
    this.profile.nickname=nickname;this.reconnectCooldown=new AdminKickCooldown(this.directory,this.profile);this.engine=null;this.stoppedDialog=null;this.interior=-1;
    this.spawned=false;this.paused=false;this.marketForce=false;
    if(this.market)this.market.lastSlot=null;
    return this.connect();
  }
  async setAfk(wanted){
    if(this.diagnosticOnly){this.notice('AFK no disponible en el diagnostico de solo lectura.');return false;}
    if(wanted&&this.serverMenu.holding){this.serverMenu.reset();this.serverMenu.pauseRequested=true;}
    if(wanted&&this.vehicleTrial?.holding&&!await this.vehicleTrial.stop('AFK solicitado'))return false;
    this.afkWanted=wanted;
    if(!wanted&&this.paused&&!await this.worker.command('pause',0)){this.notice('No se pudo confirmar la desactivacion de AFK. Consulta el estado.');return false;}
    this.notice(wanted?'AFK solicitado: se activara cuando termine el login y aparezca.':'AFK desactivado.');
    return true;
  }
  attachMarket(feed,button){
    this.market=new MarketScanner(this.worker,{button,onStatus:message=>{this.notice(message);feed.status(message);},onComplete:offers=>feed.complete(offers),onDiagnostic:info=>{
      try{const safe=this.safeMarketData(info);this.market.lastDiagnostic=safe;fs.writeFileSync(path.join(this.directory,'state/market-diagnostic.json'),JSON.stringify(safe,null,2),{mode:0o600});}
      catch(_){this.notice('No se pudo guardar el diagnostico del mercado.');}
    }});
    try{const file=path.join(this.directory,'state/market-diagnostic.json');if(fs.statSync(file).size<=131072){const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old?.v===1)this.market.lastDiagnostic=this.safeMarketData(old);}}catch(_){}
    try{this.marketEnabled=JSON.parse(fs.readFileSync(path.join(this.directory,'state/market-enabled.json'),'utf8')).enabled===true;}catch(_){}
  }
  safeMarketData(value,depth=0){
    if(depth>8)return null;
    if(typeof value==='string')return redact(value,this.profile).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,256);
    if(Array.isArray(value))return value.slice(0,64).map(item=>this.safeMarketData(item,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,this.safeMarketData(item,depth+1)]));
    return value;
  }
  marketInfo(){return this.safeMarketData({etapaActual:this.market?.phase??'sin preparar',ultimoFallo:this.market?.lastDiagnostic??null,aviso:this.market?.lastDiagnostic?'Diagnostico del ultimo fallo; no se envio ninguna compra.':'No hay un fallo del mercado guardado.'});}
  setMarket(enabled){
    if(!newGamersHost(this.profile.host)){this.notice('El analizador de placas solo esta configurado para NewGamers #1.');return;}
    if(!this.market){this.notice('El analizador no esta preparado. Revisa el inicio del hosting.');return;}
    this.marketEnabled=enabled;
    fs.writeFileSync(path.join(this.directory,'state/market-enabled.json'),JSON.stringify({enabled}),{mode:0o600});
    if(!enabled&&this.market.active)this.market.fail('Analizador pausado.',Date.now(),false);
    this.notice(enabled?'Analizador activo: cajas hasta $600 por placa, horario de Cuba.':'Analizador pausado.');
  }
  async pump(){
    if(this.diagnosticOnly)return;
    if(this.busy||this.worker.closed)return;this.busy=true;
    try{
      this.serverMenu.expire();
      if(this.vehicleTrial)await this.vehicleTrial.pump();
      if(this.engine&&!this.serverMenu.holding&&!this.accessCompleted){
        const engine=this.engine;
        const message=await engine.pump(this.snapshot);
        if(this.engine!==engine)return;
        if(message)this.notice(message);
        if(engine.failed&&!this.blocked){
          this.blocked=true;this.nextRetry=0;
          if(this.snapshot.dialog)this.stoppedDialog={...this.snapshot.dialog};
          this.notice('Acceso automatico detenido; reconexion suspendida. Usa dialogo para consultar lo que pide el servidor.');
        }
      }
      if(!this.accessCompleted&&this.snapshot.state===3&&this.spawned&&this.engine?.completed===this.profile.steps.length&&!this.blocked){
        this.accessCompleted=true;if(this.mapLocation)this.emit('mapLocation',this.mapLocation);
      }
      if(this.serverMenu.pauseRequested&&!this.serverMenu.holding&&this.afkWanted&&this.serverMenu.ready()){
        const epoch=this.serverMenu.epoch;
        if(await this.worker.command('restoreMenuPause')&&this.serverMenu.epoch===epoch&&!this.serverMenu.holding&&this.snapshot.state===3){
          this.serverMenu.pauseRequested=false;this.paused=true;this.notice('AFK restaurado tras el control de menus. La cuenta sigue conectada.');
        }
      }
      if(this.afkOnly&&this.snapshot.state===3&&!this.spawned&&!this.blocked&&this.engine?.completed===this.profile.steps.length&&!this.snapshot.dialog&&!this.snapshot.selecting){
        const now=Date.now();
        if(!this.spawnTryAt)this.spawnTryAt=now+2100;
        if(this.spawnChecks<3&&now>=this.spawnTryAt){
          this.spawnTryAt=now+12000;this.spawnChecks++;
          if(await this.worker.spawn())this.notice('Acceso enviado; aparicion solicitada al servidor.');
        }
      }
      if(this.snapshot.state===3&&this.spawned&&this.engine?.completed===this.profile.steps.length&&!this.blocked){
        this.attempts=0;
        const now=Date.now();
        if(!this.marketReadyAt)this.marketReadyAt=now+5000;
        if(this.market&&newGamersHost(this.profile.host)){
          const timing=schedule(new Date(now));
          if(!this.activityGate?.owner&&!this.serverMenu.holding&&this.marketEnabled&&!this.market.active&&now>=this.marketReadyAt&&(this.marketForce||this.market.lastSlot!==timing.slot)&&!this.snapshot.dialog&&!this.snapshot.selecting){
            this.market.lastSlot=timing.slot;this.marketForce=false;
            if(this.paused){
              if(!await this.worker.command('pause',0)){this.notice('No se pudo reanudar la sincronizacion para revisar el mercado.');return;}
              this.paused=false;
              // A manual trial may reserve the account while pause(0) is pending.
              if(this.activityGate?.owner){this.marketForce=true;return;}
              this.market.start(now);this.market.notBefore=now+2100;
              this.notice('Mercado: sincronizacion reanudada durante la revision; AFK se restaurara al cerrar los menus.');
            }else {this.market.start(now);this.market.notBefore=now;}
          }
          if(this.market.active&&now>=this.market.notBefore)await this.market.pump(this.snapshot,now);
        }
        if(this.afkWanted&&!this.paused&&!this.serverMenu.holding&&!this.vehicleTrial?.holding&&!this.snapshot.dialog&&!this.snapshot.selecting&&!this.market?.active){
          if(await this.worker.command('restorePause')){this.paused=true;this.notice('AFK activo. La cuenta permanece conectada desde el hosting.');}
        }
      }
      if(this.desired&&!this.blocked&&this.snapshot.state===0&&!this.connecting&&this.nextRetry&&Date.now()>=this.nextRetry&&(this.afkOnly||inWindow(this.profile.reconnect)))await this.connect(false);
    }finally{this.busy=false;}
  }
  dialogInfo(){
    const dialog=this.snapshot.dialog||this.stoppedDialog;
    if(!dialog)return {aviso:'No hay un dialogo disponible para consultar.'};
    const step=this.profile.steps[this.engine?.completed??0];
    const clean=value=>redact(String(value??''),this.profile).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
    return {
      origen:this.snapshot.dialog?'Dialogo actual':'Ultimo dialogo que detuvo el acceso',
      titulo:clean(dialog.title),estilo:dialog.style,aceptar:clean(dialog.yes),cancelar:clean(dialog.no),contenido:clean(dialog.body),
      pasoEsperado:step?.kind??'recorrido terminado',
      coincide:step?.kind==='dialog'?{
        estilo:dialog.style===step.style,titulo:normalize(dialog.title)===normalize(step.title),
        aceptar:normalize(dialog.yes)===normalize(step.yes),contenido:!step.body||normalize(dialog.body)===normalize(step.body)
      }:null
    };
  }
  connectionInfo(){return {...this.connectionDiagnostic.report(this.profile.nickname,this.snapshot.state,!this.worker.closed),acceso:this.loginTrace.report(this.snapshot,this.engine,this.spawned),red:this.worker.wireguard?.info()??{transporte:'directo'},pausaReconex:this.reconnectCooldown.info(),...(this.worker.nativeInterface?{interfazNativa:this.worker.nativeInterface.report()}:{} )};}
  status(){
    let nativeMemory=null;
    try{const match=fs.readFileSync('/proc/'+this.worker.child.pid+'/status','utf8').match(/^VmRSS:\s+(\d+) kB/m);if(match)nativeMemory=Math.round(Number(match[1])/1024);}catch(_){}
    return {...this.reconnectCooldown.info(),modoDiagnostico:this.diagnosticOnly,cuenta:this.profile.nickname,servidor:this.profile.host+':'+this.profile.port,estado:this.snapshot.state,loginPasos:this.engine?.completed||0,loginTotal:this.profile.steps.length,aparecido:this.spawned,accesoCompletado:this.accessCompleted,afk:this.paused,afkSolicitado:this.afkWanted,interior:this.interior??-1,reconexion:this.desired&&this.profile.reconnect.enabled&&!this.blocked,requiereRevision:this.blocked,mensajeServidor:this.accessRejection,mercadoActivo:this.marketEnabled,mercadoRevisando:this.market?.active===true,mercadoEtapa:this.market?.phase??'sin preparar',memoriaNodeMiB:Math.round(process.memoryUsage().rss/1048576),memoriaClienteMiB:nativeMemory,diagnosticoConexion:this.connectionInfo(),...(this.vehicleTrial?{pruebaVehiculo:this.vehicleTrial.status()}:{} )};
  }
}
async function createCloudClient(directory,profile,{vehicleGate=null,afkOnly=false,ngCompatibility=false,wireguard=null,nativeUiDiagnostics=false,diagnosticOnly=false}={}){
  if(wireguard)await wireguard.start();
  const worker=new Worker(workerPath(__dirname),{ngCompatibility,wireguard,nativeUiDiagnostics,redactNativeText:text=>redact(text,profile)});
  if(wireguard){const lost=()=>worker.close().catch(()=>{});wireguard.once('lost',lost);worker.once('closed',()=>wireguard.removeListener('lost',lost));}
  try{
    await new Promise((resolve,reject)=>{
      const ready=event=>{if(event.type==='workerReady'){
        if(nativeUiDiagnostics&&(event.version!=='native-ui-0.6.8'||event.packetInventory!==true||event.uiInventoryProbe!==true||event.nativeUiObserver!==true||event.readOnlyUi!==true)){
          const error=Error('El ejecutable no admite este diagnostico. Extrae tambien bin/rakmagic-worker-0.6.8-ui del despliegue.');error.code='NATIVE_UI_UNSUPPORTED';finish(error);
        }else finish();
      }};
      const closed=()=>finish(Error('WORKER_CLOSED'));
      const finish=error=>{clearTimeout(timer);worker.removeListener('event',ready);worker.removeListener('closed',closed);error?reject(error):resolve();};
      const timer=setTimeout(()=>finish(Error('WORKER_TIMEOUT')),3000);worker.on('event',ready);worker.once('closed',closed);
    });
    const client=new CloudClient(worker,directory,profile,{restoreAccountChoice:false,afkOnly,diagnosticOnly});
    if(vehicleGate)new VehicleDiagnostic(client,vehicleGate);
    return client;
  }catch(error){await worker.close();throw error;}
}
async function main({vehicleDiagnostics=false,afkOnly=true,nativeUiDiagnostics=true,diagnosticOnly=true,dataDirectory=__dirname}={}){
  const directory=path.resolve(dataDirectory);
  vehicleDiagnostics=vehicleDiagnostics&&!afkOnly;
  const vehicleGate=vehicleDiagnostics?new VehicleGate():null;
  let key;
  try{key=identity(directory);}catch(_){console.error('No se pudo cargar la identidad privada del hosting. Conserva state/host-key.pem.');process.exitCode=1;return;}
  console.log('RAKMAGIC CLOUD 0.6.8 - FALCONIX - DIAGNOSTICO INTERFAZ NATIVA - NEGOCIACION MANUAL');
  if(diagnosticOnly)console.log('Diagnostico manual: arranque de cuentas, login automatico, reconexion y AFK desactivados.');
  console.log('Clave publica: descarga host-key.json desde Archivos. Huella SHA-256: '+key.fingerprint);
  try{prepareWorker(__dirname);}catch(error){console.error(error.message);process.exitCode=1;return;}
  const feed=new MarketFeed(directory);let feedServer=null,manager=null,ending=false,commands=Promise.resolve(),restoreTimer=null;
  const enqueue=run=>{const result=commands.then(run);commands=result.catch(()=>{});return result;};
  const control=new HostControl(()=>ending?null:manager,enqueue);
  control.menus=new ServerMenuControl(()=>ending||diagnosticOnly?null:manager,enqueue);
  control.map=new AccountMap(directory,()=>ending?null:manager,enqueue);
  function config(){let values={};const file=path.join(directory,'.env');if(fs.existsSync(file)&&fs.statSync(file).size<=16384)values=parseEnv(fs.readFileSync(file,'utf8'));return values;}
  let ngCompatibility=false;
  try{
    const value=process.env.RAKMAGIC_NG_COMPAT??config().RAKMAGIC_NG_COMPAT??'0';
    if(!/^[01]$/.test(value))throw Error('INVALID_COMPAT_OPTION');
    ngCompatibility=value==='1';
  }catch(_){console.log('RAKMAGIC_NG_COMPAT debe ser 0 o 1.');process.exitCode=1;return;}
  if(diagnosticOnly)ngCompatibility=false;
  console.log(diagnosticOnly?'Compatibilidad experimental de launcher desactivada. Respuesta de inventario F4 disponible solo con interfaz negociar Nombre_Apellido.':ngCompatibility?'Compatibilidad PC experimental activada para NewGamers. La aceptacion del servidor no esta confirmada.':'Compatibilidad PC experimental desactivada. RAKMAGIC_NG_COMPAT=1 permite activarla.');

  let vpn;
  try{
    const settings=config(),value=process.env.RAKMAGIC_WG_ENABLED??settings.RAKMAGIC_WG_ENABLED??'0';
    if(!/^[01]$/.test(value))throw Error('WG_OPTION');
    vpn=new WireGuard(directory,{enabled:value==='1',file:process.env.RAKMAGIC_WG_CONFIG??settings.RAKMAGIC_WG_CONFIG??'wireguard.conf',binaryDirectory:__dirname});
    vpn.on('notice',message=>console.log(message));
    console.log(vpn.enabled?'WireGuard activado para el juego. Conexion directa bloqueada; usa vpn estado.':'WireGuard desactivado. RAKMAGIC_WG_ENABLED=1 permite activarlo.');
  }catch(_){console.log('RAKMAGIC_WG_ENABLED debe ser 0 o 1 y RAKMAGIC_WG_CONFIG una ruta de archivo.');process.exitCode=1;return;}

  try{
    const address=process.env.RAKMAGIC_MARKET_ADDRESS??config().RAKMAGIC_MARKET_ADDRESS;
    if(address){feedServer=await serveFeed(directory,key,feed,address,control);console.log('Control preparado. En RakMagic abre Control del hosting y usa Vincular con codigo.');console.log('Direccion del hosting: '+address);console.log('Codigo de 6 digitos (10 minutos, un solo uso): '+feedServer.pairing.open());}
    else console.log('Para recibir avisos, configura RAKMAGIC_MARKET_ADDRESS en .env con https://DIRECCION:PUERTO del hosting.');
  }catch(error){
    if(error.code==='EADDRINUSE')console.log('No arranco la vinculacion: el puerto ya esta ocupado. Reinicia por completo el hosting y comprueba que JS_FILE sea index.js.');
    else if(error.code==='EACCES')console.log('No arranco la vinculacion: falta permiso para ese puerto. Usa el puerto asignado por Wispbyte en RAKMAGIC_MARKET_ADDRESS.');
    else console.log('No arranco la vinculacion. Revisa RAKMAGIC_MARKET_ADDRESS y el puerto asignado por Wispbyte.');
  }
  const load=async()=>{
    if(manager?.hasActive()){console.log('Primero usa desconectar todas.');return;}
    let profile;
    try{profile=decryptProfile(path.join(directory,'cloud-profile.json'),key);}catch(_){console.log('Acceso pendiente de configurar. Vincula RakMagic con el codigo y pulsa Enviar login guardado; la app lo enviara directamente.');return false;}
    try{const configured=newIpPassword(directory);if(configured!==undefined)profile.newIpPassword=configured;}
    catch(_){console.log('No se pudo cargar la clave de nueva IP. Revisa .env o la variable RAKMAGIC_NEW_IP_PASSWORD; su valor no se mostrara.');return;}
    let button=null;
    try{const file=path.join(directory,'market-button.json');if(!afkOnly&&fs.existsSync(file)){if(fs.statSync(file).size>8192)throw Error();button=validateButton(JSON.parse(fs.readFileSync(file,'utf8')));}}
    catch(_){console.log('market-button.json no es valido. Vuelve a aprender el boton desde RakMagic.');}
    let limit=3;
    try{const value=process.env.RAKMAGIC_MAX_ACCOUNTS??config().RAKMAGIC_MAX_ACCOUNTS;if(value!==undefined){if(!/^[1-5]$/.test(value))throw Error();limit=Number(value);}}
    catch(_){console.log('RAKMAGIC_MAX_ACCOUNTS debe ser un numero de 1 a 5.');return;}
    clearTimeout(restoreTimer);if(manager)await manager.close();
    if(afkOnly){profile.afk=false;profile.autoSpawn=true;profile.autoStart=true;profile.reconnect.enabled=true;}
    if(diagnosticOnly){profile.autoStart=false;profile.autoSpawn=false;profile.reconnect.enabled=false;profile.afk=false;}
    const current=manager=new SessionManager(directory,profile,{limit,feed:afkOnly?null:feed,button,createClient:async p=>{
      if(afkOnly){p.autoSpawn=true;p.reconnect.enabled=true;}
      if(diagnosticOnly){p.autoStart=false;p.autoSpawn=false;p.reconnect.enabled=false;p.afk=false;}
      const client=await createCloudClient(directory,p,{vehicleGate,afkOnly,ngCompatibility:ngCompatibility&&newGamersHost(p.host),wireguard:vpn,nativeUiDiagnostics,diagnosticOnly});
      client.on('mapLocation',location=>control.map.capture({host:p.host,port:p.port},p.nickname,location));return client;
    }});
    current.vpn=vpn;
    current.on('notice',message=>console.log(message));
    console.log('Perfil cargado: '+profile.nickname+'. Comprueba que esa cuenta este desconectada en el movil.');
    console.log('Capacidad: '+limit+' cuentas simultaneas. Conecta cada una por su nombre desde RakMagic.');
    if(diagnosticOnly)console.log('Diagnostico preparado. Ninguna cuenta se conecta al iniciar. Consulta interfaz estado.');
    else if(afkOnly)console.log('Modo cuentas: aparicion automatica; AFK segun la preferencia de cada cuenta; reconexion durante todo el dia. Mercado y rutas desactivados.');
    let pending=[...current.restoreNames].slice(0,limit);
    const restore=()=>{restoreTimer=setTimeout(()=>enqueue(async()=>{
      if(ending||manager!==current)return;
      const name=pending.shift(),record=current.records.get(name?.toLowerCase());
      if(name&&record?.wanted){
        try{await current.connectAccount(name);}catch(error){console.log(error.code==='WIREGUARD'?error.message:'No se pudo restaurar una cuenta. Consulta cuentas.');}
      }
      if(pending.length)restore();
    }).catch(()=>{}),2100);};
    if(pending.length)restore();
    return true;
  };
  control.installProfile=body=>enqueue(async()=>{
    if(ending)return {code:503,body:{message:'El hosting se esta cerrando.'}};
    if(manager?.hasActive())return {code:409,body:{message:'Desconecta las cuentas antes de cambiar el login del hosting.'}};
    const temporary=path.join(directory,'state/profile-upload-'+require('node:crypto').randomUUID()+'.json');
    try{
      const serialized=JSON.stringify(body);
      if(Buffer.byteLength(serialized)>768*1024)return {code:413,body:{message:'El perfil es demasiado grande.'}};
      fs.writeFileSync(temporary,serialized,{mode:0o600,flag:'wx'});
      decryptProfile(temporary,key); // Validate and decrypt before replacing any existing profile.
      newIpPassword(directory);
      const limit=process.env.RAKMAGIC_MAX_ACCOUNTS??config().RAKMAGIC_MAX_ACCOUNTS;
      if(limit!==undefined&&!/^[1-5]$/.test(limit))throw Error('CONFIG');
      fs.renameSync(temporary,path.join(directory,'cloud-profile.json'));
      const ready=await load();
      if(!ready)return {code:503,body:{message:'Perfil recibido; revisa la configuracion del hosting.'}};
      return {code:200,body:{ok:true,message:'Login recibido y preparado. Ya puedes conectar las cuentas desde la app.',status:control.status()}};
    }catch(_){return {code:422,body:{message:'No se pudo preparar el perfil. Comprueba el login guardado y vuelve a vincular si cambio la clave del hosting.'}};}
    finally{try{fs.unlinkSync(temporary);}catch(_){}}
  });
  const help=()=>{console.log('Comandos: interfaz estado | interfaz diagnostico [Nombre_Apellido] | interfaz canales [Nombre_Apellido] | interfaz negociar Nombre_Apellido | vincular | vpn estado | estado | cuentas | cuenta Nombre_Apellido | conectar [Nombre_Apellido] | desconectar [Nombre_Apellido|todas] | recargar | dialogo | conexion diagnostico [Nombre_Apellido] | salir');};
  const input=readline.createInterface({input:process.stdin,terminal:false});
  input.on('line',line=>{
    if(line.length>256)return;
    if(vehicleDiagnostics&&line.trim().toLowerCase()==='vehiculo parar'&&vehicleGate.owner){vehicleGate.owner.stop().catch(()=>console.log('No se pudo confirmar la cancelacion.'));return;}
    enqueue(async()=>{
      const raw=line.trim(),command=raw.toLowerCase();
      if(command==='recargar'){await load();return;}
      if(command==='salir'){await shutdown();return;}
      if(command==='ayuda'){help();return;}
      if(command==='interfaz estado'){
        console.log(JSON.stringify({version:'0.6.8',paso:2,lecturaInterfaz:nativeUiDiagnostics,inventarioPaquetes:true,negociacionInterfazManual:true,modo:diagnosticOnly?'diagnostico-manual':'normal',arranqueAutomatico:!diagnosticOnly,loginAutomatico:!diagnosticOnly,afkAutomatico:!diagnosticOnly,cuentasActivas:manager?.clients.size??0,valoresEntradaRegistrados:false,accionesInterfazImplementadas:false},null,2));return;
      }
      if(command==='vpn estado'){console.log(JSON.stringify(vpn.info(),null,2));return;}
      if(command==='vincular'){
        if(!feedServer?.pairing){console.log('Configura RAKMAGIC_MARKET_ADDRESS en .env con la direccion del hosting.');return;}
        console.log('Codigo de 6 digitos (10 minutos, un solo uso): '+feedServer.pairing.open());return;
      }
      if(!manager){console.log('Vincula RakMagic con el codigo y pulsa Enviar login guardado al hosting.');return;}
      const parts=raw.split(/\s+/),client=manager.focus();
      if(command==='estado')console.log(JSON.stringify({...manager.getControlStatus().session,...manager.getControlStatus()},null,2));
      else if(command==='cuentas')console.log(JSON.stringify(manager.getControlStatus(),null,2));
      else if(command==='conexion diagnostico'||/^conexion diagnostico [A-Za-z0-9_\[\]().$=@]{3,24}$/.test(command))console.log(JSON.stringify(manager.connectionInfo(parts[2]||manager.selected),null,2));
      else if(command==='interfaz diagnostico'||/^interfaz diagnostico [A-Za-z0-9_\[\]().$=@]{3,24}$/.test(command)){
        const nickname=parts[2]||manager.selected,info=manager.connectionInfo(nickname);
        console.log(JSON.stringify({cuenta:nickname,disponible:!!info.interfazNativa,...(info.interfazNativa||{aviso:'Esa cuenta no tiene un lector activo. Este comando no inicia conexiones.'})},null,2));
      }
      else if(command==='interfaz canales'||/^interfaz canales [A-Za-z0-9_\[\]().$=@]{3,24}$/.test(command)){
        const nickname=parts[2]||manager.selected,info=manager.connectionInfo(nickname),data=info.datos,ui=info.interfazNativa;
        console.log(JSON.stringify({version:'0.6.8',cuenta:nickname,disponible:data?.packetInventoryAvailable===true,
          estado:info.estadoActual,paquetes:data?.packetTypes??[],rpcsSinManejar:data?.unhandledRpcs??[],
          interfazF4:ui?{operaciones:ui.operacionesRecibidas,controles:ui.totalControles,lecturaCompleta:ui.lecturaCompleta}:null,
          pantallaSamp:info.acceso?.estadoActual??null,ultimoDialogo:info.acceso?.ultimoDialogoRecibido??null,
          dialogosRecibidos:info.acceso?.dialogosRecibidos??[],
          mensajesServidor:info.acceso?.mensajesServidor??[],
          negociacion:ui?.negociacion??null,accionesEnviadas:ui?.accionesEnviadas??0,accionesControlesEnviadas:0,aviso:'Metadatos de recepcion; no incluyen cuerpos de paquetes ni confirman acceso a la cuenta.'},null,2));
      }
      else if(/^interfaz negociar [A-Za-z0-9_\[\]().$=@]{3,24}$/.test(command)){
        const target=manager.target(parts[2]);
        if(!target||!await target.negotiateUiInventory())console.log('No se envio el inventario: la cuenta debe estar conectada sin un dialogo SA-MP abierto, haber recibido la solicitud F4 y no haber respondido ya en este intento.');
        else console.log('['+target.profile.nickname+'] Inventario vacio de interfaces puesto en cola. Espera nuevos mensajes y consulta interfaz canales. Login y AFK siguen desactivados.');
      }
      else if(parts[0].toLowerCase()==='cuenta'&&parts.length===2){manager.select(parts[1]);console.log('Cuenta seleccionada: '+manager.selected);}
      else if(command==='dialogo')console.log(JSON.stringify(client?.dialogInfo()||{aviso:'No hay un dialogo disponible para consultar.'},null,2));
      else if(parts[0].toLowerCase()==='conectar'&&parts.length<=2)await manager.connectAccount(parts[1]||manager.selected);
      else if(command==='desconectar todas'){for(const name of manager.restoreNames){const r=manager.records.get(name.toLowerCase());if(r)r.wanted=false;}manager.restoreNames=[];manager.save();for(const c of [...manager.clients.values()])await manager.disconnectAccount(c.profile.nickname);}
      else if(parts[0].toLowerCase()==='desconectar'&&parts.length<=2)await manager.disconnectAccount(parts[1]||manager.selected);
      else if(parts[0].toLowerCase()==='afk'&&['on','off'].includes(parts[1]?.toLowerCase())&&parts.length<=3)await manager.setAccountAfk(parts[2]||manager.selected,parts[1].toLowerCase()==='on');
      else if(vehicleDiagnostics&&parts[0].toLowerCase()==='vehiculo'){const result=await vehicleCommand(client,raw,{directory,profile:{...manager.source,nickname:manager.selected}});if(result&&typeof result==='object')console.log(JSON.stringify(result,null,2));}
      else if(command.startsWith('mercado ')){
        if(afkOnly){console.log('Este programa esta dedicado al acceso de cuentas y AFK.');return;}
        manager.handoff();const owner=manager.marketOwner;
        if(!owner){console.log('Conecta al menos una cuenta antes de revisar el mercado.');return;}
        if(command==='mercado on'||command==='mercado off')owner.setMarket(command==='mercado on');
        else if(command==='mercado revisar'){owner.setMarket(true);owner.marketForce=true;console.log('Revision solicitada; se hara una sola vez desde '+owner.profile.nickname+'.');}
        else if(command==='mercado diagnostico')console.log(JSON.stringify(owner.marketInfo(),null,2));else help();
      }
      else if(command==='chat on'||command==='chat off'){if(client){client.chat=command==='chat on';console.log('Chat '+(client.chat?'activado':'desactivado')+' para '+client.profile.nickname);}}
      else help();
    }).catch(error=>console.log(error.code&&error.message?error.message:'No se pudo confirmar el comando. Consulta cuentas.'));
  });
  const timer=setInterval(()=>manager?.pump(),100);
  async function shutdown(){if(ending)return;ending=true;clearInterval(timer);clearTimeout(restoreTimer);control.map.close();if(manager)await manager.close();await vpn.close();if(feedServer)feedServer.close();input.close();}
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  help();await load();
}
module.exports={CloudClient,createCloudClient,inWindow,main};
if(require.main===module)main().catch(()=>{console.error('No se pudo iniciar RakMagic Cloud.');process.exitCode=1;});
