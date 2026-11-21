'use strict';
const {normalize,newGamersHost}=require('./automation.cjs');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {redact}=require('./profile.cjs');
const fold=s=>normalize(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const trialDistance=metres=>metres===5?'cinco metros':metres===1?'un metro':metres+' metros';
const trialReason=reason=>({
  'route-access-search-limit':'no se encontro espacio suficiente para el Sultan en una conexion',
  'checkpoint-road-access-too-far':'no se encontro una conexion continua con la red de calles',
  'route-planning-timeout':'el calculo supero el tiempo permitido',
  'checkpoint-access-blocked':'el mapa bloquea el acceso al checkpoint',
  'checkpoint-height-or-access-mismatch':'el tramo final no alcanza la altura del checkpoint',
  'checkpoint-changed':'el servidor cambio el checkpoint',
  'checkpoint-removed':'el servidor retiro el checkpoint; comprueba si entrego las placas',
  'route-origin-changed':'la posicion del Sultan cambio despues de calcular el recorrido',
  'vehicle-not-ready':'el Sultan necesita conductor, motor encendido y salud valida',
  'mapped-obstacle-in-segment':'la geometria del mapa bloquea el tramo',
  'vehicle-in-segment':'otro vehiculo ocupa el tramo previsto',
  'missing-vehicle-data':'faltan datos de movimiento de otro vehiculo',
  'stale-vehicle-data':'los datos de movimiento de otro vehiculo estan desactualizados',
  'unknown-vehicle-size':'se desconoce el tamaño de otro vehiculo',
  'ground-not-level':'el suelo cambia demasiado de altura o de pendiente en el tramo',
  'unsupported-ground-clearance':'la altura del Sultan no coincide con el suelo de apoyo',
  'missing-ground':'no hay suelo conocido debajo del tramo',
  'outside-coverage':'el tramo sale de la region de colisiones',
  'vehicle-stream-changed':'cambio la lista de vehiculos visibles',
  'own-vehicle-stream-changed':'el servidor actualizo o retiro el Sultan de la prueba',
  'server-vehicle-position':'el servidor corrigio la posicion del Sultan'
}[reason]||reason||'faltan datos del controlador');
class VehicleError extends Error {constructor(message){super(message);this.code='vehicle-diagnostic';}}
class VehicleGate {constructor(){this.owner=null;this.clients=new Set();}}
function diagnosticFile(directory,profile){return path.join(directory,'state','vehicle-diagnostic-'+crypto.createHash('sha256').update(JSON.stringify([profile.host,profile.port,profile.nickname.toLowerCase()])).digest('hex').slice(0,24)+'.json');}
function readVehicleDiagnostic(directory,profile){
  try{const file=diagnosticFile(directory,profile);if(fs.statSync(file).size>65536)return null;const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    return saved?.v===1&&saved.host===profile.host&&saved.port===profile.port&&saved.cuenta?.toLowerCase()===profile.nickname.toLowerCase()?saved:null;
  }catch(_){return null;}
}
class VehicleDiagnostic {
  constructor(client,gate=new VehicleGate(),now=Date.now){
    if(client.vehicleTrial||client.activityGate)throw Error('ACTIVITY_ALREADY_ATTACHED');
    this.client=client;this.worker=client.worker;this.gate=gate;this.now=now;
    this.phase='idle';this.reason='';this.result='sin probar';this.native=null;this.nativeAt=0;this.version=0;
    this.epoch=0;this.nextAt=0;this.deadline=0;this.target=null;this.trace=[];this.pending=null;this.stopping=null;
    this.messages=[];this.normalSeenAt=0;this.lastDiagnostic=readVehicleDiagnostic(client.directory,client.profile);
    this.closed=()=>this.reset();this.worker.on('closed',this.closed);gate.clients.add(client);
    client.vehicleTrial=this;client.activityGate=gate;
  }
  get holding(){return this.gate.owner===this;}
  get supported(){return Array.isArray(this.worker.readyInfo?.capabilities)&&this.worker.readyInfo.capabilities.includes('vehicle-diagnostic-v1');}
  notice(message){this.client.notice('Vehiculo: '+message);}
  ensure(ok,message){if(!ok)throw new VehicleError(message);}
  ready(){const c=this.client;return !this.worker.closed&&c.snapshot.state===3&&c.spawned&&!c.blocked&&c.engine?.completed===c.profile.steps.length&&c.interior===0;}
  current(epoch){this.ensure(this.epoch===epoch&&this.holding&&!this.stopping,'Operacion de vehiculo cancelada.');}
  reset(){if(this.planner){this.planner.kill();this.planner=null;}++this.epoch;this.phase='idle';this.target=null;this.native=null;this.nativeAt=0;if(this.holding)this.gate.owner=null;}
  observe(event){
    if(event.type==='state'&&event.state<=1)this.reset();
    if(event.type==='vehicleDiagnostic'){this.native=event;this.nativeAt=this.now();this.version++;}
    if(event.type==='log'&&this.holding)this.messages=[...this.messages,this.clean(event.text)].slice(-8);
  }
  clean(value){return redact(normalize(String(value??'')),this.client.profile).replace(/[\x00-\x1f\x7f]/g,'').slice(0,256);}
  capture(reason=this.reason){
    const d=this.client.snapshot.dialog;
    const screen=d?{titulo:this.clean(d.title),estilo:d.style,aceptar:this.clean(d.yes),cancelar:this.clean(d.no)}:null;
    if(screen&&/^(?:llaves|permisos de vehiculos)/.test(fold(d.title)))screen.opciones=String(d.body).split('\n').slice(0,32).map(s=>this.clean(s));
    this.lastDiagnostic={v:1,host:this.client.profile.host,port:this.client.profile.port,cuenta:this.client.profile.nickname,time:new Date(this.now()).toISOString(),etapa:this.phase,motivo:this.clean(reason),resultado:this.result,menus:this.trace.map(t=>({titulo:this.clean(t.titulo),opcion:this.clean(t.opcion)})),pantalla:screen,mensajesServidor:this.messages,datosVehiculo:this.native,planificador:this.routePlanReport||null};
    try{const file=diagnosticFile(this.client.directory,this.client.profile);if(fs.existsSync(path.dirname(file)))fs.writeFileSync(file,JSON.stringify(this.lastDiagnostic),{mode:0o600});}catch(_){}
  }
  async refresh(){
    // An IPC acknowledgement can arrive in a different stdout chunk before the
    // snapshot. Install the listener before sending and await both independently.
    const version=this.version;let finish;
    const snapshot=new Promise(resolve=>finish=resolve);
    const received=e=>{if(e.type==='vehicleDiagnostic')finish(true);};
    const closed=()=>finish(false),timer=setTimeout(()=>finish(false),3000);
    this.worker.on('event',received);this.worker.once('closed',closed);
    try{
      this.ensure(await this.worker.command('vehicleStatus'),'No se pudo solicitar el estado de los vehiculos.');
      this.ensure(await snapshot&&this.version>version,'No llego una lectura reciente de los vehiculos.');return this.native;
    }finally{clearTimeout(timer);this.worker.removeListener('event',received);this.worker.removeListener('closed',closed);}
  }
  async begin(){
    this.ensure(this.supported,'Instala el worker del ZIP de diagnostico.');
    this.ensure(this.phase==='idle'&&!this.stopping,'Usa vehiculo parar antes de repetir.');
    this.ensure(this.ready()&&!this.client.snapshot.dialog&&!this.client.snapshot.selecting,'Termina el login y cierra los menus antes de probar.');
    this.ensure(!this.gate.owner,'Otra cuenta esta usando el diagnostico del vehiculo.');
    this.ensure(![...this.gate.clients].some(c=>c.market?.active),'Espera a que termine la revision del mercado.');
    this.gate.owner=this;this.phase='preparing';this.reason='';this.trace=[];this.messages=[];this.routePlanReport=null;
    const epoch=++this.epoch;
    const run=(async()=>{
      const deadline=this.now()+3000;
      while([...this.gate.clients].some(c=>c.busy)){this.current(epoch);this.ensure(this.now()<deadline,'La cuenta sigue ocupada. Reintenta al terminar.');await delay(10);}
      this.current(epoch);this.ensure(this.ready()&&!this.client.snapshot.dialog&&!this.client.snapshot.selecting,'La cuenta cambio de pantalla.');
      this.ensure(await this.worker.command('pause',0),'No se pudo reanudar la sincronizacion.');this.current(epoch);this.client.paused=false;
      await this.refresh();this.current(epoch);this.deadline=this.now()+15000;
    })();
    this.pending=run;
    try{await run;return epoch;}catch(error){if(epoch===this.epoch)await this.stop(error.message);throw error;}
    finally{if(this.pending===run)this.pending=null;}
  }
  async call(){
    this.ensure(newGamersHost(this.client.profile.host)||this.client.profile.host==='127.0.0.1','El menu /llaves esta preparado para NewGamers.');
    const epoch=await this.begin();this.current(epoch);
    this.target=null;this.phase='open';this.nextAt=Math.max(this.now(),(this.client.engine?.lastAttempt||0)+2100);this.deadline=this.nextAt+15000;
    this.result='llamada solicitada';this.notice('llamando al Sultan con Servicio de Grua 108; se cobra la tarifa del servidor.');return true;
  }
  rows(dialog){
    this.ensure([2,4,5].includes(dialog.style)&&fold(dialog.yes)==='continuar','El menu de llaves tiene un formato diferente.');
    const offset=dialog.style===5?1:0;
    return String(dialog.body).split('\n').slice(offset).map((value,item)=>({item,value:value.split('\t')[0],label:fold(value.split('\t')[0])}));
  }
  async choose(dialog,predicate,next,epoch){
    const rows=this.rows(dialog).filter(row=>predicate(row.label));
    this.ensure(rows.length===1,'No hay una unica opcion esperada en '+normalize(dialog.title)+'. Usa vehiculo diagnostico.');
    const row=rows[0];this.trace.push({titulo:normalize(dialog.title),opcion:normalize(row.value)});this.trace=this.trace.slice(-8);
    if(next==='spawn')this.calledRevision=this.native?.revision??0;
    this.ensure(await this.worker.reply(dialog.serial,dialog.id,true,row.item,row.value),'No se pudo confirmar la seleccion de llaves.');this.current(epoch);
    if(this.client.snapshot.dialog?.serial===dialog.serial)this.client.snapshot.dialog=null;
    this.phase=next;this.nextAt=this.now()+2100;this.deadline=this.now()+15000;
  }
  async board(id){
    let epoch=this.epoch;
    if(!this.holding){epoch=await this.begin();this.phase='sultan-ready';}
    this.ensure(this.phase==='sultan-ready'&&!this.stopping,'Espera a que termine la llamada del Sultan.');
    try{
      await this.refresh();this.current(epoch);
      this.ensure(this.ready()&&!this.client.snapshot.dialog&&!this.client.snapshot.selecting,'La cuenta no esta lista para subir.');
      const target=id??this.target;
      const chosen=this.native.sultans.find(c=>c.id===target);
      if(chosen&&chosen.distance>6)throw new VehicleError('Sultan detectado a '+chosen.distance.toFixed(1)+' m; la subida admite hasta 6 m. Copia vehiculo diagnostico, sin repetir la grua.');
      this.ensure(Number.isInteger(target)&&this.native.sultans.some(c=>c.id===target&&c.distance<=6&&!c.locked),'Usa vehiculo llamar primero, o indica el ID de tu Sultan cercano.');
      this.ensure(!this.native.vehicle&&!this.native.clientVehicle,'El cliente ya tiene un vehiculo activo. Consulta vehiculo diagnostico.');
      this.target=target;this.normalSeenAt=0;this.result='entrada solicitada';this.phase='boarding';this.deadline=this.now()+8000;
      this.ensure(await this.worker.command('vehicleBoard',target),'No se pudo enviar la solicitud para subir.');this.current(epoch);
      this.notice('subida solicitada al Sultan '+target+'; completando la entrada normal del cliente.');return true;
    }catch(error){if(epoch===this.epoch)await this.stop(error.message);throw error;}
  }
  routeAssets(){
    try{
      const directory=this.client.directory,asset=path.join(directory,'data/collision/ColAndreas.cadb'),roads=path.join(directory,'data/traffic/GPS.dat'),updated=path.join(directory,'rakmagic-route-planner-0.2.15'),binary=fs.existsSync(updated)?updated:path.join(directory,'rakmagic-route-planner');
      const manifest=JSON.parse(fs.readFileSync(path.join(directory,'data/traffic/route-assets.json'),'utf8'));
      this.ensure(manifest.version===1,'El manifiesto de rutas no es valido.');
      for(const [file,sha,maximum] of [[asset,manifest.collisionSha256,67108864],[roads,manifest.roadsSha256,4194304]])this.ensure(fs.statSync(file).size<=maximum&&crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')===sha,'Los datos de la ruta no coinciden con el ZIP completo 0.2.12.');
      require('./native-binary.cjs').prepareExecutable(binary,0o755);return {asset,roads,binary};
    }catch(error){throw error instanceof VehicleError?error:new VehicleError('Faltan datos o permisos del planificador. Instala el ZIP completo 0.2.12 antes de pedir placas.');}
  }
  async requestPlates(){
    this.ensure(newGamersHost(this.client.profile.host)||this.client.profile.host==='127.0.0.1','El pedido esta preparado para NewGamers.');
    this.ensure(this.worker.readyInfo?.capabilities?.includes('vehicle-checkpoint-route-v1'),'Instala el ZIP completo 0.2.12 para la ruta al checkpoint.');
    const epoch=await this.begin();this.current(epoch);
    try{
      this.ensure(this.native.clientVehicle||this.native.vehicle&&this.native.seat===0,'Sube al Sultan antes de pedir las placas.');
      this.ensure(!this.native.checkpoint?.active,'Ya hay un checkpoint activo. Usa vehiculo ruta sin hacer otro pedido.');this.routeAssets();
      this.phase='traffic-open';this.nextAt=Math.max(this.now(),(this.client.engine?.lastAttempt||0)+2100);this.deadline=this.nextAt+15000;this.result='pedido de placas solicitado';
      this.notice('se solicitara UNA caja de 20 placas por $8,500 mediante /traficoarmas; no se repetira el pedido.');return true;
    }catch(error){if(this.epoch===epoch)await this.stop(error.message);throw error;}
  }
  async prepareRoute(){
    this.ensure(this.worker.readyInfo?.capabilities?.includes('vehicle-checkpoint-route-v1'),'Instala el ZIP completo 0.2.12 para la ruta al checkpoint.');
    const epoch=await this.begin();return this.planRoute(epoch);
  }
  async planRoute(epoch){
    try{
      await this.refresh();this.current(epoch);
      this.ensure(this.native.clientVehicle||this.native.vehicle&&this.native.seat===0,'Sube al Sultan antes de preparar la ruta.');
      const cp=this.native.checkpoint,car=this.native.sultans?.find(c=>c.id===(this.native.clientVehicle||this.native.vehicle));
      this.ensure(cp?.active&&cp.position?.length===3&&cp.position.every(Number.isFinite),'No hay un checkpoint activo. Usa vehiculo placas para solicitar un pedido.');
      this.ensure(car&&Number.isFinite(car.angle),'No hay una orientacion actual del Sultan.');
      if(Math.hypot(...this.native.position.map((p,i)=>p-cp.position[i]))<=Math.max(.25,cp.radius-.5)){
        this.result='Sultan dentro del checkpoint';this.notice('el Sultan ya esta dentro del CP. Comprueba el mensaje de entrega y el inventario.');await this.stop('destino ya alcanzado');return true;
      }
      const directory=this.client.directory,{asset,roads,binary}=this.routeAssets();
      const target=path.join(directory,'state/vehicle-route.plan'),jobFile=path.join(directory,'state/.vehicle-route-'+crypto.randomBytes(10).toString('hex')+'.tmp');fs.mkdirSync(path.dirname(target),{recursive:true});
      try{fs.unlinkSync(target);}catch(error){if(error.code!=='ENOENT')throw error;}
      this.phase='route-planning';this.routeCheckpoint=structuredClone(cp);this.result='calculando ruta al checkpoint';this.deadline=this.now()+180000;
      this.routePlanReport={origen:[...this.native.position],angulo:car.angle,checkpoint:structuredClone(cp),resultado:'calculando',mapaBase:true};
      this.notice('calculando el recorrido al CP activo con el mapa completo. El Sultan espera detenido; vehiculo parar cancela.');
      const child=spawn(binary,[asset,roads,jobFile,...this.native.position,car.angle,...cp.position,cp.radius,cp.revision].map(String),{cwd:directory,stdio:['ignore','pipe','pipe']});
      this.planner=child;let output='',error='',done=false;
      child.stdout.on('data',b=>{output=(output+b).slice(-8192);});child.stderr.on('data',b=>{error=(error+b).slice(-8192);});
      const finish=async(code)=>{
        if(done)return;done=true;if(this.planner===child)this.planner=null;if(this.epoch!==epoch||!this.holding){try{fs.unlinkSync(jobFile);}catch(_){}return;}
        try{
          this.routePlanReport={...this.routePlanReport,codigoSalida:code,resultado:code===0?'calculado':'sin recorrido',registro:error.trim().split('\n').slice(-12).map(line=>this.clean(line))};
          this.ensure(code===0,'No se pudo completar la ruta: '+trialReason(error.match(/ROUTE_ERROR ([^\n]+)/)?.[1]||'fallo del planificador')+'. No se inicio movimiento.');
          const result=JSON.parse(output.trim());this.ensure(result.ok&&result.metres>0,'El planificador no devolvio un recorrido.');
          await this.refresh();this.current(epoch);this.ensure(this.native.checkpoint?.active&&this.native.checkpoint.revision===cp.revision,'El checkpoint cambio durante el calculo.');
          fs.renameSync(jobFile,target);
          this.ensure(await this.worker.command('vehicleRouteLoad'),'El worker rechazo el recorrido.');this.current(epoch);await this.refresh();this.current(epoch);
          const trial=this.native.shortTrial;this.ensure(trial?.kind==='checkpoint-route'&&trial.phase==='prepared'&&trial.checkpointRevision===cp.revision,'El recorrido no quedo preparado: '+trialReason(trial?.reason));
          this.phase='test-ready';this.testRoute=true;this.testDuration=trial.estimatedSeconds;this.testCurve=null;this.testMetres=trial.metres;this.deadline=this.now()+120000;this.result='ruta al checkpoint preparada';
          this.notice('ruta al CP preparada: '+Math.round(trial.metres)+' m, maximo 4 m/s. Usa vehiculo probar para iniciar en 120 s; vehiculo parar cancela.');
        }catch(error){try{fs.unlinkSync(jobFile);}catch(_){}if(this.epoch===epoch)await this.stop(error instanceof VehicleError?error.message:'No se pudo cargar la ruta al checkpoint.');}
      };
      child.once('error',()=>{finish(-1).catch(()=>{});});child.once('close',code=>{finish(code).catch(()=>{});});return true;
    }catch(error){if(this.epoch===epoch)await this.stop(error instanceof VehicleError?error.message:'Faltan archivos de la ruta. Instala el ZIP completo 0.2.12.');throw error;}
  }
  async prepareCurve(side){return this.prepareTest(2,true,side);}
  async prepareTest(metres=5,ignoreTraffic=true,curveSide=null){
    this.ensure(Number.isInteger(metres)&&metres>=1&&metres<=5,'Usa vehiculo preparar [1-5]; la distancia debe ser un numero entero de metros.');
    this.ensure(typeof ignoreTraffic==='boolean','El modo sintrafico debe ser explicito.');
    this.ensure(curveSide===null||(['izquierda','derecha'].includes(curveSide)&&ignoreTraffic&&metres===2),'Usa vehiculo curva izquierda | derecha.');
    this.ensure(this.worker.readyInfo?.capabilities?.includes('vehicle-short-distance-v2')&&this.worker.readyInfo.capabilities.includes('vehicle-model-sizes-v1')&&this.worker.readyInfo.capabilities.includes('vehicle-corridor-v1')&&this.worker.readyInfo.capabilities.includes('vehicle-ground-support-v1')&&(!ignoreTraffic||this.worker.readyInfo.capabilities.includes('vehicle-ignore-traffic-v1')),'Instala el ZIP completo 0.2.11 para la prueba corta.');
    this.ensure(!curveSide||this.worker.readyInfo.capabilities.includes('vehicle-curve-trial-v1'),'Instala el ZIP completo 0.2.11 para la prueba de curva.');
    const epoch=await this.begin();this.current(epoch);this.phase='test-preparing';
    try{
      this.ensure(this.native.clientVehicle||this.native.vehicle&&this.native.seat===0,'Sube al Sultan antes de preparar la prueba.');
      this.ensure(ignoreTraffic||!(this.native.rejectedAdds>0),'Prueba bloqueada: se recibieron datos de vehiculos que no se pudieron interpretar. Copia vehiculo diagnostico.');
      const file=path.join(this.client.directory,'data/collision/drive-region.json');
      this.ensure(fs.statSync(file).size<=4096,'La region de prueba no es valida.');
      const region=JSON.parse(fs.readFileSync(file,'utf8')),bounds=[...region.coverage.min,...region.coverage.max];
      this.ensure(region.version===1&&bounds.length===6&&bounds.every(n=>Number.isFinite(n)&&Math.abs(n)<=10000),'La region de prueba no es valida.');
      const asset=path.join(this.client.directory,'data/collision/sultan-probe.cadb');
      this.ensure(fs.statSync(asset).size<=4194304&&crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex')===region.sha256,'La region de colisiones no coincide con su archivo de datos.');
      const sent=curveSide?await this.worker.command('vehicleCurvePrepare',...bounds,curveSide==='derecha'?1:-1):await this.worker.command('vehicleDrivePrepare',...bounds,metres,...(ignoreTraffic?[1]:[]));this.current(epoch);await this.refresh();this.current(epoch);
      this.ensure(sent&&this.native.shortTrial?.phase==='prepared'&&this.native.shortTrial.metres===metres&&Boolean(this.native.shortTrial.ignoreTraffic)===ignoreTraffic,'Prueba bloqueada: '+trialReason(this.native.shortTrial?.reason)+'. Copia vehiculo diagnostico.');
      this.ensure(!curveSide||(this.native.shortTrial.kind==='curve'&&this.native.shortTrial.curve?.side===curveSide),'El worker devolvio otra prueba de movimiento. Instala el ZIP completo 0.2.11.');
      this.testRoute=false;this.testMetres=metres;this.testCurve=curveSide;this.phase='test-ready';this.result=curveSide?'curva '+curveSide+' preparada':'prueba de '+trialDistance(metres)+' preparada';this.deadline=this.now()+120000;
      this.notice((curveSide?'curva a la '+curveSide+' preparada: 15 grados en dos metros, maximo 0.65 m/s.':'prueba preparada: '+trialDistance(metres)+' al frente, maximo 1 m/s.')+(ignoreTraffic?' SIN TRAFICO: se ignoran todos los demas vehiculos; puede atravesarlos.':'')+' Revisa el destino con vehiculo diagnostico. Usa vehiculo probar en 120 s para iniciar; vehiculo parar cancela.');return this.diagnostic();
    }catch(error){if(epoch===this.epoch){this.result='preparacion bloqueada';await this.stop(error.message);}throw error;}
  }
  async startTest(){
    this.ensure(this.holding&&this.phase==='test-ready'&&!this.stopping,'Usa vehiculo preparar y comprueba que la prueba quede preparada.');
    const epoch=this.epoch;
    try{
      this.ensure(this.now()<=this.deadline,'La preparacion expiro.');
      this.ensure(await this.worker.command('vehicleDriveStart'),'El entorno cambio y la prueba no pudo arrancar. Copia vehiculo diagnostico.');this.current(epoch);
      this.phase='testing';this.result=this.testRoute?'ruta al checkpoint en curso':'prueba corta en curso';this.deadline=this.now()+(this.testRoute?(Number.isFinite(this.testDuration)?this.testDuration*1000+60000:this.testMetres/1.5*1000+90000):20000);this.notice((this.testRoute?'ruta al checkpoint iniciada':this.testCurve?'curva a la '+this.testCurve+' iniciada':'prueba de '+trialDistance(this.testMetres)+' iniciada')+'; vehiculo parar detiene el ensayo.');return true;
    }catch(error){if(epoch===this.epoch)await this.stop(error.message);throw error;}
  }
  async pump(){
    if(!this.holding||this.stopping||['preparing','test-preparing','fault'].includes(this.phase))return;
    try{
      this.ensure(this.ready()&&!this.client.paused,'La cuenta no esta disponible para el diagnostico.');
      this.ensure(this.now()-this.nativeAt<2000,'No hay datos recientes de vehiculos.');
      const now=this.now(),epoch=this.epoch,d=this.client.snapshot.dialog;
      if(this.phase==='route-planning'){
        this.ensure(!d&&!this.client.snapshot.selecting,'Se abrio otra pantalla durante el calculo.');
        this.ensure(this.native.checkpoint?.active&&this.native.checkpoint.revision===this.routeCheckpoint.revision,'El checkpoint cambio durante el calculo.');
        this.ensure(now<=this.deadline,'El calculo de la ruta tardo demasiado.');return;
      }
      if(this.phase==='traffic-open'&&now>=this.nextAt){
        this.phase='traffic-menu';this.deadline=now+15000;this.ensure(await this.worker.send('/traficoarmas'),'No se pudo enviar /traficoarmas.');this.current(epoch);this.nextAt=now+2100;return;
      }
      if(this.phase==='traffic-menu'&&d&&now>=this.nextAt){
        this.ensure(fold(d.title)==='trafico de armas'&&[2,4,5].includes(d.style)&&fold(d.yes)==='pedir','El menu de trafico tiene un formato diferente. Consulta dialogo.');
        const rows=String(d.body).split('\n').slice(d.style===5?1:0).map((value,item)=>({value,item,label:fold(value)}));
        const matches=rows.filter(r=>/box\s+p\.?\s*armadura/.test(r.label)&&/\b20\s+unidades\b/.test(r.label)&&/\$8[,.]?500\b/.test(r.label));
        this.ensure(matches.length===1,'No hay una caja unica de 20 placas por $8,500. No se confirmo ningun pedido.');
        const row=matches[0];this.phase='traffic-checkpoint';this.deadline=now+20000;
        this.ensure(await this.worker.reply(d.serial,d.id,true,row.item,row.value),'No se pudo solicitar la caja.');this.current(epoch);
        if(this.client.snapshot.dialog?.serial===d.serial)this.client.snapshot.dialog=null;return;
      }
      if(this.phase==='traffic-checkpoint'&&this.native.checkpoint?.active){await this.planRoute(epoch);return;}
      if(['test-ready','testing'].includes(this.phase)){
        this.ensure(!d&&!this.client.snapshot.selecting,'Se abrio otra pantalla durante la prueba.');
        const trial=this.native.shortTrial;
        if(this.phase==='testing'&&trial?.phase==='finished'){this.result=this.testRoute?'recorrido al checkpoint terminado':'prueba corta terminada';this.notice((this.testRoute?'recorrido al checkpoint terminado':this.testCurve?'curva a la '+this.testCurve+' terminada':trialDistance(this.testMetres)+(this.testMetres===1?' terminado':' terminados'))+(this.testRoute?' y velocidad final cero. Comprueba el mensaje del servidor y el inventario para confirmar la entrega.':' y velocidad final cero. Verifica el resultado desde otra cuenta.'));await this.stop(this.testRoute?'recorrido al checkpoint terminado':'tramo corto terminado');return;}
        this.ensure(trial&&['prepared','running'].includes(trial.phase),'Prueba detenida: '+trialReason(trial?.reason)+'. Copia vehiculo diagnostico.');
      }
      if(this.phase==='boarding'&&this.native.vehicle===this.target&&this.native.seat===0){
        this.result='conductor confirmado por el servidor';this.notice('el servidor confirmo al conductor del Sultan. Conduccion desactivada en esta version.');await this.stop('entrada comprobada');return;
      }
      if(this.phase==='boarding'&&this.native.entryState==='interrupted'){
        this.result='entrada interrumpida';throw new VehicleError('La entrada fue interrumpida: '+this.native.entryReason+'. Copia vehiculo diagnostico.');
      }
      if(this.phase==='boarding'&&this.native.clientVehicle===this.target&&this.native.entrySyncPackets>0){
        if(!this.normalSeenAt)this.normalSeenAt=now;
        if(now-this.normalSeenAt>=2000){
          this.result='entrada normal enviada; comprobacion externa pendiente';
          this.notice('entrada normal y sincronizacion estacionaria enviadas al Sultan '+this.target+'. Comprueba desde otra cuenta si esta sentado dentro; el protocolo no devuelve una confirmacion de asiento para esta entrada.');
          await this.stop('prueba de entrada enviada');return;
        }
      }
      if(this.phase==='spawn'&&this.messages.some(message=>/no tienes suficiente dinero/i.test(fold(message)))){
        this.result='grua rechazada';throw new VehicleError('El servidor rechazo la grua por falta de dinero. Asegura el pago antes de llamar de nuevo.');
      }
      if(now>this.deadline){
        if(this.phase==='boarding')this.result='entrada sin confirmar';
        throw new VehicleError(this.phase==='boarding'?'El servidor no confirmo la subida. No se asumio que estas conduciendo; copia vehiculo diagnostico.':'Tiempo agotado en '+this.phase+'. Copia vehiculo diagnostico.');
      }
      if(now<this.nextAt)return;
      if(this.phase==='open'){
        this.ensure(!d&&!this.client.snapshot.selecting,'Hay otra pantalla abierta.');this.phase='keys';this.deadline=now+15000;
        this.ensure(await this.worker.send('/llaves'),'No se pudo enviar /llaves.');this.current(epoch);this.nextAt=this.now()+2100;return;
      }
      if(['keys','vehicles','actions'].includes(this.phase)&&d){
        const title=fold(d.title);
        if(this.phase==='keys'){this.ensure(/^llaves prestadas$/.test(title),'Pantalla distinta de Llaves prestadas.');await this.choose(d,s=>/^vehiculo\s*\(\d+\/\d+\)$/.test(s),'vehicles',epoch);}
        else if(this.phase==='vehicles'){this.ensure(/^permisos de vehiculos\s*\(\d+\/\d+\)$/.test(title),'Pantalla distinta de Permisos de vehiculos.');await this.choose(d,s=>s==='sultan','actions',epoch);}
        else {this.ensure(/^llaves:\s*sultan(?:\s*\[[^\]]+\])?$/.test(title),'Las llaves no corresponden al Sultan.');await this.choose(d,s=>/^(?:\[\d+\]\s*)?servicio de grua 108\s*\(traer a tu posicion\)$/.test(s),'spawn',epoch);}
      }else if(this.phase==='spawn'){
        this.ensure(!d&&!this.client.snapshot.selecting,'El servidor abrio otra pantalla tras llamar la grua.');
        // Tow placement distance is a server choice. Discovery uses 30 m;
        // boarding retains its independent 6 m bound in Node and native code.
        const candidates=this.native.sultans.filter(c=>c.distance<=30&&c.revision>this.calledRevision);
        this.ensure(candidates.length<=1,'Aparecieron varios Sultan cercanos; revisa los IDs antes de subir.');
        if(candidates.length===1){this.target=candidates[0].id;this.phase='sultan-ready';this.deadline=now+120000;this.result='Sultan cercano detectado';this.notice('Sultan detectado: ID '+this.target+' a '+candidates[0].distance.toFixed(1)+' m. '+(candidates[0].distance<=6?'Ahora usa vehiculo subir.':'Esta fuera del alcance de subida; copia vehiculo diagnostico sin repetir la grua.'));}
      }else if(['sultan-ready','boarding'].includes(this.phase))this.ensure(!d&&!this.client.snapshot.selecting,'Se abrio otra pantalla durante la prueba.');
    }catch(error){if(this.holding&&!this.stopping)await this.stop(error instanceof VehicleError?error.message:'No se pudo completar el diagnostico.');}
  }
  stop(reason='parada manual'){
    if(this.planner){this.planner.kill();this.planner=null;}if(this.stopping)return this.stopping;if(!this.holding)return Promise.resolve(true);
    if(this.phase==='testing'&&['prueba corta en curso','ruta al checkpoint en curso'].includes(this.result))this.result=this.testRoute?'ruta al checkpoint interrumpida':'prueba corta interrumpida';
    this.capture(reason);++this.epoch;const pending=this.pending;this.phase='stopping';this.reason=reason;
    const run=(async()=>{
      let ok=await this.worker.command('vehicleCancel');if(pending)await pending.catch(()=>{});
      if(!this.holding)return true;
      if(!ok){this.phase='fault';this.notice('cancelacion sin confirmar. Desconecta esta cuenta.');return false;}
      this.phase='idle';this.gate.owner=null;this.notice(reason+'. AFK y mercado pueden continuar cuando se cierren los menus.');return true;
    })();
    this.stopping=run;run.finally(()=>{if(this.stopping===run)this.stopping=null;}).catch(()=>{});return run;
  }
  status(){return {modo:'diagnostico Sultan',cuenta:this.client.profile.nickname,disponible:this.supported,fase:this.phase,reservada:this.holding,resultado:this.result,motivo:this.reason,objetivo:this.target,conduccionDisponible:false,rutaCheckpointDisponible:!!this.worker.readyInfo?.capabilities?.includes('vehicle-checkpoint-route-v1'),antiguedadDatosMs:this.native?Math.max(0,this.now()-this.nativeAt):null,datosVehiculo:this.native};}
  diagnostic(){return { ...this.status(),menus:this.trace,planificador:this.routePlanReport||null,ultimoDiagnostico:this.lastDiagnostic,aviso:'Consultar este informe no llama a la grua ni pide subir. Una solicitud de subida no confirma que el servidor la haya aceptado.'};}
  dispose(){
    if(this.holding&&!this.worker.closed){this.stop('control cerrado').catch(()=>{});return;}
    this.reset();this.worker.removeListener('closed',this.closed);this.gate.clients.delete(this.client);delete this.client.vehicleTrial;delete this.client.activityGate;
  }
}
async function vehicleCommand(client,line,context){
  const diagnostic=client?.vehicleTrial;
  const p=line.trim().toLowerCase().split(/\s+/);
  if(!(diagnostic instanceof VehicleDiagnostic)){
    if(p.length===2&&p[1]==='diagnostico'&&context){const saved=readVehicleDiagnostic(context.directory,context.profile);if(saved)return {cuenta:context.profile.nickname,conectada:false,ultimoDiagnostico:saved};}
    throw new VehicleError('La cuenta seleccionada esta desconectada. Usa conectar Nombre_Apellido o selecciona una cuenta conectada.');
  }
  if(p.length===2){
    if(p[1]==='placas')return diagnostic.requestPlates();
    if(p[1]==='ruta')return diagnostic.prepareRoute();
    if(p[1]==='llamar')return diagnostic.call();
    if(p[1]==='subir')return diagnostic.board();
    if(p[1]==='preparar')return diagnostic.prepareTest();
    if(p[1]==='probar')return diagnostic.startTest();
    if(p[1]==='parar')return diagnostic.stop();
    if(p[1]==='estado'||p[1]==='diagnostico'){
      let errorLectura=null;try{await diagnostic.refresh();}catch(error){errorLectura=error.message;}
      return {...(p[1]==='estado'?diagnostic.status():diagnostic.diagnostic()),lecturaActualizada:errorLectura===null,...(errorLectura?{errorLectura}: {})};
    }
  }
  if(p.length===3&&p[1]==='subir'&&/^[1-9]\d{0,3}$/.test(p[2]))return diagnostic.board(Number(p[2]));
  if(p.length===3&&p[1]==='curva'&&['izquierda','derecha'].includes(p[2]))return diagnostic.prepareCurve(p[2]);
  if(p.length===3&&p[1]==='preparar'&&/^[1-5]$/.test(p[2]))return diagnostic.prepareTest(Number(p[2]));
  if(p.length===4&&p[1]==='preparar'&&/^[1-5]$/.test(p[2])&&p[3]==='sintrafico')return diagnostic.prepareTest(Number(p[2]),true);
  if(p.length===4&&p[1]==='preparar'&&/^[1-5]$/.test(p[2])&&p[3]==='contrafico')return diagnostic.prepareTest(Number(p[2]),false);
  throw new VehicleError('Usa vehiculo llamar | subir [ID] | estado | diagnostico | preparar [1-5] | curva izquierda | curva derecha | placas | ruta | probar | parar.');
}
module.exports={VehicleDiagnostic,VehicleGate,VehicleError,vehicleCommand,readVehicleDiagnostic};
