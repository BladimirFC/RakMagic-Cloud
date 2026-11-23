'use strict';
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {wire,decoder}=require('./encoding.cjs');
const {NativeUiDiagnostic}=require('./native-ui-0.6.6.cjs');
class Worker extends EventEmitter {
  constructor(binary,{ngCompatibility=false,wireguard=null,nativeUiDiagnostics=false,recordedLogin=false,redactNativeText}={}){
    super();this.wireguard=wireguard;this.sequence=0;this.pending=new Map();this.buffer='';this.closed=false;
    this.nativeInterface=nativeUiDiagnostics?new NativeUiDiagnostic({redactText:redactNativeText}):null;
    this.child=spawn(binary,[],{stdio:['pipe','pipe','pipe'],env:{...process.env,RAKMAGIC_NATIVE_UI_DIAGNOSTIC:nativeUiDiagnostics?'1':'0',RAKMAGIC_RECORDED_LOGIN:recordedLogin?'1':'0',RAKMAGIC_NG_COMPAT:ngCompatibility?'1':'0',...(wireguard?wireguard.workerEnvironment():{RAKMAGIC_WG_REQUIRED:'0',RAKMAGIC_WG_RELAY_PORT:'',RAKMAGIC_WG_RELAY_TOKEN:''})}});
    this.child.stdout.on('data',bytes=>{
      this.buffer+=decoder.decode(bytes);
      if(this.buffer.length>1048576){this.child.kill();return;}
      let index;
      while((index=this.buffer.indexOf('\n'))>=0){
        const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);
        try{
          const event=JSON.parse(line);
          // This private IPC event MUST NOT escape the worker adapter.
          if(event.type==='nativeUiPacket'){this.nativeInterface?.observe(event);continue;}
          if(event.type==='workerStatus'&&event.nativeUiTransport)this.nativeInterface?.setTransport(event.nativeUiTransport);
          if(event.type==='workerStatus'&&event.uiInventoryProbe)this.nativeInterface?.setNegotiation(event.uiInventoryProbe);
          if(event.type==='workerReply'){
            const pending=this.pending.get(event.request);
            if(pending){clearTimeout(pending.timer);this.pending.delete(event.request);pending.resolve(event.ok===true);}
          }else {if(event.type==='workerReady')this.readyInfo=event;this.emit('event',event);}
        }catch(_){this.emit('protocolError');}
      }
    });
    this.child.stderr.on('data',()=>this.emit('nativeWarning'));
    this.child.stdin.on('error',()=>{});
    this.child.on('error',()=>this.finish());
    this.child.on('exit',()=>this.finish());
  }
  finish(){
    if(this.closed)return;this.closed=true;
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.resolve(false);}
    this.pending.clear();this.emit('closed');
  }
  command(name,...arguments_){
    if(this.closed||this.pending.size>=8)return Promise.resolve(false);
    const id=++this.sequence;
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.pending.delete(id);resolve(false);},3000);
      this.pending.set(id,{resolve,timer});
      this.child.stdin.write([id,name,...arguments_].join(' ')+'\n');
    });
  }
  async connect(ip,port,name,password){this.nativeInterface?.reset();if(this.wireguard)await this.wireguard.authorize(ip,port);return this.command('connect',wire(ip),port,wire(name),wire(password));}
  click(id,revision){return this.command('click',id,revision);}
  reply(serial,id,yes,item,value){return this.command('reply',serial,id,yes?1:0,item,wire(value));}
  send(value){return this.command('send',wire(value));}
  spawn(){return this.command('spawn');}
  cancelSelection(){return this.command('cancelSelection');}
  async waitClosed(ms){
    if(this.closed)return;
    await new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);this.removeListener('closed',done);resolve();};
      const timer=setTimeout(done,ms);this.once('closed',done);
      if(this.closed)done();
    });
  }
  close(){
    if(this.closing)return this.closing;
    this.stopping=true;
    return this.closing=(async()=>{
      if(this.closed)return;
      await this.command('quit');this.child.stdin.end();
      if(!this.closed)this.child.kill('SIGTERM');await this.waitClosed(1000);
      if(!this.closed){this.child.kill('SIGKILL');await this.waitClosed(1000);}
      if(!this.closed)throw Error('WORKER_NOT_CLOSED');
    })();
  }
}
module.exports={Worker};
