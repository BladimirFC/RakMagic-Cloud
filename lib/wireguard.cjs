'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {randomBytes}=require('node:crypto');
const {isIP}=require('node:net');
const EGRESS_TTL=120000;
const {prepareExecutable}=require('./native-binary.cjs');
const messages={
  WG_CONFIG_MISSING:'Falta wireguard.conf junto a index.js. Sube tu configuracion privada de WireGuard.',
  WG_CONFIG_INVALID:'wireguard.conf no tiene un formato valido.',
  WG_ONE_PEER_REQUIRED:'La configuracion debe tener una seccion Interface y una Peer.',
  WG_UNSUPPORTED_OPTION:'La configuracion contiene una opcion que este cliente no admite. No se ejecutaran scripts.',
  WG_DUPLICATE_OPTION:'La configuracion repite una opcion.',
  WG_KEY_INVALID:'La configuracion contiene una clave WireGuard no valida.',
  WG_ENDPOINT_INVALID:'Endpoint debe indicar una IP publica y un puerto validos.',
  WG_ALLOWED_IPS_INVALID:'AllowedIPs no es valido.',
  WG_ADDRESS_INVALID:'Address no es valido.',
  WG_DNS_INVALID:'DNS debe contener direcciones IP.',
  WG_MTU_INVALID:'MTU debe estar entre 1280 y 1420.',
  WG_KEEPALIVE_INVALID:'PersistentKeepalive no es valido.',
  WG_CONFIGURATION_REJECTED:'WireGuard rechazo la configuracion.',
  WG_NETWORK_UNAVAILABLE:'El hosting no pudo abrir la conexion UDP de WireGuard.',
  WG_NETSTACK_FAILED:'No se pudo preparar la red privada de WireGuard.',
  WG_LOOPBACK_UNAVAILABLE:'El hosting no pudo abrir el adaptador local de WireGuard.'
};
function problem(message){const e=new Error(message);e.code='WIREGUARD';return e;}
class WireGuard extends EventEmitter{
  constructor(directory,{enabled=false,file='wireguard.conf',binaryDirectory=directory}={}){
    super();this.directory=directory;this.binaryDirectory=path.resolve(binaryDirectory);this.enabled=enabled;this.file=path.resolve(directory,file);
    this.pending=new Map();this.sequence=0;this.ready=false;this.failed=false;this.stopping=false;this.lastStatus=null;this.lastStatusAt=0;this.egress=null;this.egressAt=0;this.egressAttemptAt=0;this.egressReason='sin consultar';
  }
  async start(){
    if(!this.enabled)return null;
    if(this.ready&&!this.failed)return this;
    if(this.failed)throw problem(this.failure||'WireGuard se detuvo. Reinicia el hosting para volver a prepararlo.');
    if(this.starting)return this.starting;
    this.starting=this.prepare();return this.starting;
  }
  async prepare(){
    try{
      const stat=fs.statSync(this.file);
      if(!stat.isFile()||stat.size<32||stat.size>65536)throw problem('wireguard.conf no es un archivo de configuracion valido.');
      fs.chmodSync(this.file,0o600);
      const binary=prepareExecutable(path.join(this.binaryDirectory,'rakmagic-wireguard-0.6.5'));
      this.token=randomBytes(16).toString('hex');this.buffer='';
      const child=this.child=spawn(binary,['--config',this.file],{stdio:['pipe','pipe','pipe']});
      this.exitPromise=new Promise(resolve=>{child.once('close',resolve);});
      const started=new Promise((resolve,reject)=>{
        let settled=false;
        const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
        const timer=setTimeout(()=>{this.failure='WireGuard no termino de preparar el adaptador local.';finish(problem(this.failure));child.kill('SIGTERM');},15000);
        child.stdout.on('data',bytes=>{
          this.buffer+=bytes.toString('utf8');
          if(this.buffer.length>65536){finish(problem('WireGuard devolvio una respuesta no valida.'));child.kill('SIGTERM');return;}
          let newline;while((newline=this.buffer.indexOf('\n'))>=0){
            const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);
            let value;try{value=JSON.parse(line);}catch(_){continue;}
            if(value.type==='ready'&&value.transport==='wireguard'&&Number.isInteger(value.port)&&value.port>0&&value.port<=65535){
              this.port=value.port;this.ready=true;this.startedAt=Date.now();finish();
              this.emit('notice','WireGuard: adaptador preparado. El intercambio con el proveedor se confirmara en vpn estado.');
            }else if(value.type==='reply'){
              const p=this.pending.get(value.id);if(p&&p.kind!=='egress'){clearTimeout(p.timer);this.pending.delete(value.id);p.resolve(value.ok===true);}
            }else if(value.type==='egress'){
              const p=this.pending.get(value.id);
              if(p?.kind==='egress'){clearTimeout(p.timer);this.pending.delete(value.id);p.resolve(value);}
            }else if(value.type==='status'){
              this.lastStatus={handshake:value.handshake===true,handshakeAgeSeconds:Number.isSafeInteger(value.handshakeAgeSeconds)&&value.handshakeAgeSeconds>=0?value.handshakeAgeSeconds:null,receivedBytes:Number.isSafeInteger(value.receivedBytes)&&value.receivedBytes>=0?value.receivedBytes:0,sentBytes:Number.isSafeInteger(value.sentBytes)&&value.sentBytes>=0?value.sentBytes:0,flows:Number.isInteger(value.flows)?value.flows:0};this.lastStatusAt=Date.now();
              if(this.lastStatus.handshake&&!this.announcedHandshake){this.announcedHandshake=true;this.emit('notice','WireGuard: intercambio confirmado con el servidor VPN. La IP observada se muestra por separado en vpn estado.');}
            }else if(value.type==='fatal'){
              this.failure=messages[value.code]||'WireGuard no pudo iniciarse. Revisa su configuracion.';
              finish(problem(this.failure));
            }
          }
        });
        child.stdin.on('error',()=>{});
        child.stderr.on('data',()=>{}); // Never forward native errors or key-bearing IPC.
        child.once('error',()=>{this.failure='No se pudo ejecutar rakmagic-wireguard-0.6.5. Extrae el ZIP completo.';finish(problem(this.failure));});
        child.once('close',()=>{
          const wasReady=this.ready;this.ready=false;this.failed=!this.stopping;
          for(const p of this.pending.values()){clearTimeout(p.timer);p.resolve(false);}this.pending.clear();
          finish(problem(this.failure||'WireGuard se cerro antes de preparar la conexion.'));
          if(wasReady&&!this.stopping){this.failure=this.failure||'WireGuard se detuvo. Las cuentas no usaran la conexion directa; reinicia el hosting.';this.emit('notice',this.failure);this.emit('lost');}
        });
      });
      child.stdin.write(JSON.stringify({op:'start',token:this.token})+'\n');
      await started;return this;
    }catch(e){
      this.failed=true;
      if(e.code==='ENOENT')this.failure=messages.WG_CONFIG_MISSING;
      else this.failure=e.code==='WIREGUARD'||String(e.code).startsWith('NATIVE_')?e.message:'No se pudo preparar WireGuard. Revisa wireguard.conf y sus permisos.';
      if(this.child&&!this.child.killed)this.child.kill('SIGTERM');
      throw problem(this.failure);
    }
  }
  async authorize(ip,port){
    if(!this.enabled)return;
    await this.start();
    if(!this.ready||this.failed||this.stopping)throw problem('WireGuard no esta disponible. La conexion directa permanece bloqueada.');
    if(this.beforeUse)await this.beforeUse();
    const id=++this.sequence;
    const ok=await new Promise(resolve=>{
      const timer=setTimeout(()=>{this.pending.delete(id);resolve(false);},3000);this.pending.set(id,{resolve,timer});
      this.child.stdin.write(JSON.stringify({op:'allow',id,ip,port})+'\n');
    });
    if(!ok)throw problem('WireGuard no autorizo el destino del juego. Revisa AllowedIPs; no se utilizara la conexion directa.');
  }
  egressFresh(){return this.ready&&!this.failed&&!!this.egress&&Date.now()-this.egressAt<EGRESS_TTL;}
  async verify({force=false}={}){
    if(!this.enabled)return false;
    await this.start();
    if(this.verifying)return this.verifying;
    if(!force&&this.egressFresh()&&Date.now()-this.egressAt<10000)return true;
    this.egressAttemptAt=Date.now();
    this.verifying=(async()=>{
      const id=++this.sequence;
      const result=await new Promise(resolve=>{
        const timer=setTimeout(()=>{this.pending.delete(id);resolve(null);},14000);
        this.pending.set(id,{kind:'egress',resolve,timer});
        this.child.stdin.write(JSON.stringify({op:'verify',id})+'\n');
      });
      if(this.stopping||!this.ready||this.failed)return false;
      const valid=result?.ok===true&&isIP(result.ip)===4&&result.method==='stun-udp4-two-observers';
      this.egress=valid?result.ip:null;this.egressAt=valid?Date.now():0;
      this.egressReason=valid?'':result?.reason==='EGRESS_OBSERVERS_DISAGREE'?'Los observadores UDP detectaron salidas distintas.':'No se pudo verificar la IP mediante los dos observadores UDP.';
      return valid;
    })();
    try{return await this.verifying;}finally{this.verifying=null;}
  }
  block(reason){
    if(this.failed||this.stopping)return;
    this.failure=reason;this.failed=true;this.egress=null;this.egressAt=0;
    this.emit('notice',reason);this.emit('lost');
    if(this.child&&!this.child.killed)this.child.kill('SIGTERM');
  }
  workerEnvironment(){
    if(!this.enabled)return {RAKMAGIC_WG_REQUIRED:'0',RAKMAGIC_WG_RELAY_PORT:'',RAKMAGIC_WG_RELAY_TOKEN:''};
    if(!this.ready||this.failed)throw problem('WireGuard no esta preparado.');
    if(this.checkBeforeWorker)this.checkBeforeWorker();
    return {RAKMAGIC_WG_REQUIRED:'1',RAKMAGIC_WG_RELAY_PORT:String(this.port),RAKMAGIC_WG_RELAY_TOKEN:this.token};
  }
  info(){
    return {activado:this.enabled,transporte:this.enabled?'wireguard':'directo',adaptadorPreparado:this.ready&&!this.failed,intercambioConfirmado:this.ready&&this.lastStatus?.handshake===true,antiguedadIntercambioSegundos:this.lastStatus?.handshakeAgeSeconds??null,antiguedadLecturaMs:this.lastStatusAt?Date.now()-this.lastStatusAt:null,bytesRecibidos:this.lastStatus?.receivedBytes??0,bytesEnviados:this.lastStatus?.sentBytes??0,conexionesUDP:this.lastStatus?.flows??0,conexionDirectaPermitida:!this.enabled,ipSalidaVerificada:this.egressFresh()?this.egress:null,verificadaEn:this.egressAt?new Date(this.egressAt).toISOString():null,antiguedadVerificacionMs:this.egressAt?Date.now()-this.egressAt:null,verificacionVigente:this.egressFresh(),metodoVerificacion:'stun-udp4-two-observers',residencialVerificada:null,motivoVerificacion:this.egressReason,motivo:this.failure||'',aviso:'La VPN solo transporta UDP del juego. El control HTTPS y la resolucion inicial del nombre del servidor conservan la red del hosting. La IP observada por STUN no acredita una conexion residencial ni la IP que observa cada destino. Un intercambio WireGuard no confirma acceso al juego.'};
  }
  memoryMiB(){
    if(!this.child?.pid||!this.ready)return 0;
    try{const m=fs.readFileSync('/proc/'+this.child.pid+'/status','utf8').match(/^VmRSS:\s+(\d+) kB/m);return m?Math.ceil(Number(m[1])/1024):0;}catch(_){return 0;}
  }
  async close(){
    if(this.closing)return this.closing;
    this.stopping=true;if(!this.child)return;
    return this.closing=this.closeChild();
  }
  async closeChild(){
    this.child.stdin.end(JSON.stringify({op:'stop'})+'\n');
    const timer=setTimeout(()=>this.child.kill('SIGKILL'),2000);
    await this.exitPromise;clearTimeout(timer);this.ready=false;this.token='';
  }
}
module.exports={WireGuard,EGRESS_TTL};
