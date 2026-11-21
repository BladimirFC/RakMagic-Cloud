'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validNickname}=require('./accounts.cjs');
const {newGamersHost}=require('./automation.cjs');
const kinds=new Set(['casa','negocio','otro']);
const controls=/[\x00-\x1f\x7f]/;
const number=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=100000;
const interior=v=>v===null||Number.isInteger(v)&&v>=0&&v<=255;
const position=v=>v&&number(v.x)&&number(v.y)&&(v.z===null||number(v.z))&&interior(v.interior);
const scopeFor=(host,port)=>(newGamersHost(host)?'newgamers-1':String(host).toLowerCase())+':'+port;
class MapError extends Error {constructor(message){super(message);}}
class MapStore {
  constructor(directory){
    this.file=path.join(directory,'state/account-map.json');this.data={v:1,worlds:[]};this.failed=false;this.warning='';this.timer=null;this.dirty=false;
    try{
      const stat=fs.statSync(this.file);if(!stat.isFile()||stat.size>512*1024)throw Error();
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(data.v!==1||!Array.isArray(data.worlds)||data.worlds.length>5)throw Error();
      for(const world of data.worlds){
        if(typeof world.scope!=='string'||world.scope.length>300||!Array.isArray(world.points)||world.points.length>200||!Array.isArray(world.locations)||world.locations.length>30)throw Error();
        if(!world.locations.every(p=>position(p)&&validNickname(p.nickname)&&typeof p.updatedAt==='string'))throw Error();
        if(!world.points.every(p=>position(p)&&typeof p.id==='string'&&typeof p.name==='string'&&p.name.length>0&&p.name.length<=64&&!controls.test(p.name)&&kinds.has(p.kind)&&typeof p.createdAt==='string'))throw Error();
      }
      this.data=data;
    }catch(error){if(error.code!=='ENOENT'){this.failed=true;this.warning='No se pudieron cargar los puntos guardados. El archivo anterior se ha conservado.';}}
  }
  world(data,scope){
    let world=data.worlds.find(w=>w.scope===scope);
    if(!world){if(data.worlds.length>=5)throw new MapError('Se alcanzo el limite de mapas guardados en este hosting.');world={scope,points:[],locations:[]};data.worlds.push(world);}return world;
  }
  write(data){
    if(this.failed)throw new MapError(this.warning);
    const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';
    try{fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});fs.writeFileSync(temporary,JSON.stringify(data)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,this.file);}
    catch(_){throw new MapError('No se pudieron guardar los puntos en el hosting. Se conserva la version anterior.');}
    finally{try{fs.unlinkSync(temporary);}catch(_){}}
    this.data=data;this.dirty=false;this.warning='';clearTimeout(this.timer);this.timer=null;
  }
  capture(scope,nickname,location){
    if(!position(location)||!validNickname(nickname))return;
    try{
      const world=this.world(this.data,scope),id=nickname.toLowerCase(),index=world.locations.findIndex(p=>p.nickname.toLowerCase()===id);
      const point={nickname,x:location.x,y:location.y,z:location.z,interior:location.interior,updatedAt:location.updatedAt};
      if(index>=0)world.locations[index]=point;else world.locations.push(point);
      world.locations.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));world.locations=world.locations.slice(0,30);this.dirty=true;
      if(!this.timer&&!this.failed)this.timer=setTimeout(()=>{this.timer=null;try{this.write(this.data);}catch(error){this.warning=error.message;}},2000);
    }catch(error){this.warning=error.message;}
  }
  change(scope,run){const next=structuredClone(this.data),world=this.world(next,scope);run(world);this.write(next);}
  close(){clearTimeout(this.timer);this.timer=null;if(this.dirty&&!this.failed)try{this.write(this.data);}catch(_){} }
}
class AccountMap {
  constructor(directory,getManager,enqueue){this.getManager=getManager;this.enqueue=enqueue;this.store=new MapStore(directory);this.requests=new Map();this.secret=crypto.randomBytes(32);}
  capture(server,nickname,location){this.store.capture(scopeFor(server.host,server.port),nickname,location);}
  current(){const manager=this.getManager();if(!manager||manager.closed)return null;return {manager,scope:scopeFor(manager.source.host,manager.source.port)};}
  snapshot(){
    const current=this.current(),base={v:1,supported:true,available:!!current,bounds:{minX:-3000,maxX:3000,minY:-3000,maxY:3000},generatedAt:new Date().toISOString(),pointsAvailable:!this.store.failed,message:this.store.warning,accounts:[],points:[]};
    if(!current){base.message='Prepara las cuentas del hosting para ver su mapa.';return base;}
    const {manager,scope}=current,world=this.store.data.worlds.find(w=>w.scope===scope),status=manager.getControlStatus();
    base.scope=scope;base.accounts=status.sessions.map(row=>{
      const nickname=row.nickname,s=row.session,client=manager.clients.get(nickname.toLowerCase());
      const live=client?.accessCompleted&&client.snapshot.state===3?client.mapLocation:null;
      const saved=world?.locations.find(p=>p.nickname.toLowerCase()===nickname.toLowerCase()),point=live||saved||null;
      return {nickname,state:s.estado,available:!!row.available,connecting:!!row.connecting,connected:s.estado===3&&!!s.accesoCompletado&&!s.requiereRevision,afk:!!s.afk,afkWanted:!!s.afkSolicitado,source:live?'live':saved?'saved':'none',location:point?{x:point.x,y:point.y,z:point.z,interior:point.interior,updatedAt:point.updatedAt}:null};
    });
    base.points=world?world.points.map(p=>({...p})):[];return base;
  }
  valid(body){
    if(!body||Array.isArray(body)||typeof body.id!=='string'||!/^[A-Za-z0-9_-]{16,64}$/.test(body.id)||typeof body.action!=='string')return false;
    const extra={'save-point':['name','kind','x','y','z','interior'],'save-account':['name','kind','nickname'],'edit-point':['name','kind','pointId'],'delete-point':['pointId']}[body.action];
    if(!Array.isArray(extra)||Object.keys(body).length!==2+extra.length||!['id','action',...extra].every(key=>Object.hasOwn(body,key)))return false;
    if(body.action!=='delete-point'&&(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>64||controls.test(body.name)||!kinds.has(body.kind)))return false;
    if(body.action==='save-point')return !!position(body);
    if(body.action==='save-account')return validNickname(body.nickname);
    return typeof body.pointId==='string'&&/^[A-Za-z0-9_-]{16,64}$/.test(body.pointId);
  }
  execute(body){
    if(!this.valid(body))return Promise.resolve({code:400,body:{ok:false,message:'Punto del mapa no valido.'}});
    const now=Date.now();for(const [id,value] of this.requests)if(value.expires<=now)this.requests.delete(id);
    const signature=crypto.createHmac('sha256',this.secret).update(JSON.stringify(body)).digest('hex'),old=this.requests.get(body.id);
    if(old)return old.signature===signature?old.result:Promise.resolve({code:409,body:{ok:false,message:'Solicitud de mapa reutilizada para otra accion.'}});
    if(this.requests.size>=128)return Promise.resolve({code:429,body:{ok:false,message:'Espera unos segundos antes de guardar otro punto.'}});
    const result=this.enqueue(async()=>{
      const current=this.current();if(!current)throw new MapError('El hosting no tiene cuentas preparadas.');
      let selected;
      if(body.action==='save-account'){
        const row=this.snapshot().accounts.find(a=>a.nickname.toLowerCase()===body.nickname.toLowerCase());
        if(!row?.location)throw new MapError('Todavia no hay una ubicacion recibida de esa cuenta.');
        selected={...row.location,account:row.nickname};
      }
      this.store.change(current.scope,world=>{
        if(body.action==='delete-point'||body.action==='edit-point'){
          const index=world.points.findIndex(p=>p.id===body.pointId);if(index<0)throw new MapError('Ese punto ya no esta guardado. Actualiza el mapa.');
          if(body.action==='delete-point')world.points.splice(index,1);
          else{world.points[index].name=body.name.trim();world.points[index].kind=body.kind;world.points[index].updatedAt=new Date().toISOString();}
        }else{
          if(world.points.length>=200)throw new MapError('Ya hay 200 puntos guardados. Elimina uno antes de agregar otro.');
          const p=selected||body,time=new Date().toISOString();
          world.points.push({id:crypto.randomUUID(),name:body.name.trim(),kind:body.kind,x:p.x,y:p.y,z:p.z,interior:p.interior,account:p.account||null,createdAt:time,updatedAt:time});
        }
      });
      return {code:200,body:{v:1,ok:true,message:body.action==='delete-point'?'Punto eliminado.':'Punto guardado en el hosting.',map:this.snapshot()}};
    }).catch(error=>({code:409,body:{ok:false,message:error instanceof MapError?error.message:'No se confirmo el cambio del mapa. Actualiza antes de repetirlo.'}}));
    this.requests.set(body.id,{signature,result,expires:now+60000});return result;
  }
  close(){this.store.close();}
}
module.exports={AccountMap};
