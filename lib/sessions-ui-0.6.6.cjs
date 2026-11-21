'use strict';
const fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {validNickname,readChoice,saveChoice}=require('./accounts.cjs');
const canonical=name=>name.toLowerCase();
class SessionError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
class SessionManager extends EventEmitter {
  constructor(directory,profile,{createClient,limit=3,feed=null,button=null,memoryLimit=448}={}){
    super();this.directory=directory;this.profile=structuredClone(profile);this.createClient=createClient;
    this.limit=Number.isInteger(limit)&&limit>=1&&limit<=5?limit:3;this.memoryLimit=memoryLimit;
    this.connectionReports=new Map();
    this.feed=feed;this.button=button;this.clients=new Map();this.records=new Map();this.closed=false;this.marketOwner=null;this.lastMarketSlot=null;
    this.source={host:profile.host,port:profile.port,nickname:profile.nickname};
    const choice=readChoice(directory,this.source);this.selected=choice?.nickname||profile.nickname;
    this.accountNames=[...new Map([profile.nickname,...(choice?.names||[])].map(n=>[canonical(n),n])).values()].slice(-30);
    let hadPlan=false;
    try{
      const file=path.join(directory,'state/account-sessions.json');if(fs.statSync(file).size>16384)throw Error();
      const saved=JSON.parse(fs.readFileSync(file,'utf8'));
      if(saved.v!==1||saved.source?.host!==this.source.host||saved.source?.port!==this.source.port||saved.source?.nickname!==this.source.nickname||!Array.isArray(saved.accounts)||saved.accounts.length>30)throw Error();
      if(!saved.accounts.every(r=>r&&validNickname(r.nickname)&&typeof r.afk==='boolean'&&typeof r.wanted==='boolean'))throw Error();
      for(const record of saved.accounts)this.records.set(canonical(record.nickname),{...record});
      hadPlan=true;
    }catch(_){}
    for(const name of this.accountNames)if(!this.records.has(canonical(name)))this.records.set(canonical(name),{nickname:name,afk:!!profile.afk,wanted:false});
    this.restoreNames=profile.autoStart?[...this.records.values()].filter(r=>r.wanted).map(r=>r.nickname):[];
    if(profile.autoStart&&!hadPlan){this.restoreNames=[this.selected];this.records.get(canonical(this.selected)).wanted=true;}
  }
  save(){
    fs.mkdirSync(path.join(this.directory,'state'),{recursive:true,mode:0o700});
    this.accountNames=saveChoice(this.directory,this.source,this.selected,this.accountNames);
    const active=new Set(this.clients.keys());
    const records=[...this.records.values()];
    while(records.length>30){const index=records.findIndex(r=>!active.has(canonical(r.nickname)));if(index<0)break;records.splice(index,1);}
    this.records=new Map(records.map(r=>[canonical(r.nickname),r]));
    const file=path.join(this.directory,'state/account-sessions.json'),temp=file+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({v:1,source:this.source,accounts:records})+'\n',{mode:0o600});fs.chmodSync(temp,0o600);fs.renameSync(temp,file);
  }
  memory(){return Math.round(process.memoryUsage().rss/1048576)+(this.vpn?.memoryMiB()||0)+[...this.clients.values()].reduce((sum,c)=>sum+(c.status().memoriaClienteMiB||0),0);}
  focus(){return this.clients.get(canonical(this.selected))||null;}
  target(nickname){
    if(nickname!==undefined&&!validNickname(nickname))throw new SessionError('invalid-account','Nombre de cuenta no valido.');
    if(nickname===undefined&&this.clients.size>1)throw new SessionError('target-required','Selecciona la cuenta que quieres controlar.');
    const name=nickname??([...this.clients.values()][0]?.profile.nickname||this.selected);
    return this.clients.get(canonical(name))||null;
  }
  select(nickname){
    if(!validNickname(nickname))throw new SessionError('invalid-account','Nombre de cuenta no valido.');
    this.selected=this.records.get(canonical(nickname))?.nickname||nickname;this.save();
  }
  async connectAccount(nickname){
    if(this.closed)throw new SessionError('unavailable','El hosting se esta cerrando.');
    if(!validNickname(nickname))throw new SessionError('invalid-account','Nombre de cuenta no valido.');
    const id=canonical(nickname);let client=this.clients.get(id);
    if(client?.worker.closed){client.dispose();this.clients.delete(id);client=null;this.handoff();}
    if(client&&(client.connecting||client.snapshot.state!==0)){this.selected=client.profile.nickname;this.save();return true;}
    if(!client){
      if(this.clients.size>=this.limit)throw new SessionError('account-limit','Ya estan ocupadas las '+this.limit+' plazas. Desconecta una cuenta antes de agregar otra.');
      if(this.memory()>=this.memoryLimit)throw new SessionError('memory-limit','No queda suficiente memoria para otra cuenta. Desconecta una cuenta primero.');
      const record=this.records.get(id),profile=structuredClone(this.profile);profile.nickname=nickname;profile.afk=record?.afk??!!profile.afk;
      client=await this.createClient(profile);
      if(this.closed){await client.worker.close();client.dispose();return false;}
      this.clients.set(id,client);
      client.on('notice',message=>this.emit('notice','['+client.profile.nickname+'] '+message));
      client.on('connectionReviewRequired',()=>{
        client.desired=false;client.nextRetry=0;
        const record=this.records.get(id);if(record)record.wanted=false;
        try{this.save();}catch(_){this.emit('notice','['+client.profile.nickname+'] No se pudo guardar la pausa de reconexion. Desconecta esta cuenta desde el control del hosting.');}
        this.handoff();
      });
    }
    this.selected=client.profile.nickname;
    this.accountNames=this.accountNames.filter(n=>canonical(n)!==id);this.accountNames.push(this.selected);this.accountNames=this.accountNames.slice(-30);
    const afk=client.diagnosticOnly?(this.records.get(id)?.afk??!!this.profile.afk):!!client.afkWanted;
    this.records.set(id,{nickname:this.selected,afk,wanted:true});this.save();this.handoff();
    return client.connect();
  }
  async disconnectAccount(nickname){
    const client=this.target(nickname),id=canonical(nickname??client?.profile.nickname??this.selected);
    const record=this.records.get(id);if(record)record.wanted=false;
    this.save(); // Cancel startup/reconnection intent before any asynchronous work.
    if(!client)return true;
    client.desired=false;client.nextRetry=0;
    if(!client.worker.closed&&await client.disconnect()===false)throw new Error('UNCONFIRMED');
    await client.worker.close();
    if(client.connectionInfo){this.connectionReports.delete(id);this.connectionReports.set(id,client.connectionInfo());while(this.connectionReports.size>30)this.connectionReports.delete(this.connectionReports.keys().next().value);}
    client.dispose();this.clients.delete(id);this.handoff();return true;
  }
  async setAccountAfk(nickname,wanted){
    const client=this.target(nickname);
    if(!client||client.worker.closed)throw new SessionError('account-offline','Esa cuenta esta desconectada.');
    if(await client.setAfk(wanted)===false)throw Error('UNCONFIRMED');
    const record=this.records.get(canonical(client.profile.nickname));record.afk=wanted;this.save();return true;
  }
  handoff(){
    const old=this.marketOwner;
    if(old&&this.clients.has(canonical(old.profile.nickname))&&!old.worker.closed&&!old.blocked&&old.desired&&old.snapshot.state!==0)return;
    const candidates=[...this.clients.values()].filter(c=>!c.worker.closed&&!c.blocked&&c.desired);
    const next=candidates.find(c=>c.snapshot.state===3)||candidates[0]||null;
    if(next===old)return;
    if(old){this.lastMarketSlot=old.market?.lastSlot??this.lastMarketSlot;old.market?.reset();old.market=null;old.marketEnabled=false;}
    this.marketOwner=next;
    if(next&&this.feed){next.attachMarket(this.feed,this.button);next.market.lastSlot=this.lastMarketSlot;}
  }
  pump(){
    this.handoff();
    for(const client of this.clients.values())client.pump().catch(()=>this.emit('notice','['+client.profile.nickname+'] No se pudo actualizar la sesion.'));
  }
  hasActive(){return [...this.clients.values()].some(c=>c.connecting||c.snapshot.state!==0||c.desired);}
  connectionInfo(nickname=this.selected){
    if(!validNickname(nickname))throw new SessionError('invalid-account','Nombre de cuenta no valido.');
    const client=this.clients.get(canonical(nickname));
    if(client?.connectionInfo)return client.connectionInfo();
    return structuredClone(this.connectionReports.get(canonical(nickname))||{schema:1,origen:'hosting',cuenta:nickname,disponible:false,datos:null,aviso:'Conecta esta cuenta desde el hosting para obtener su diagnostico.'});
  }
  offlineStatus(nickname){return {cuenta:nickname,servidor:this.profile.host+':'+this.profile.port,estado:0,loginPasos:0,loginTotal:this.profile.steps.length,aparecido:false,afk:false,afkSolicitado:this.records.get(canonical(nickname))?.afk??!!this.profile.afk,requiereRevision:false,reconexion:false,diagnosticoConexion:this.connectionInfo(nickname)};}
  getControlStatus(){
    const names=[...new Map([...this.accountNames,...[...this.clients.values()].map(c=>c.profile.nickname)].map(n=>[canonical(n),n])).values()];
    const sessions=names.map(name=>{const client=this.clients.get(canonical(name));return {nickname:name,available:!!client&&!client.worker.closed,connecting:!!client?.connecting,desired:!!client?.desired,session:client?client.status():this.offlineStatus(name)};});
    const focused=this.focus();
    return {v:1,multiAccount:true,serverMenus:true,accountMap:true,available:!this.closed,accountSelection:true,accounts:names,connecting:!!focused?.connecting,desired:!!focused?.desired,session:focused?focused.status():this.offlineStatus(this.selected),sessions,
      capacity:{limit:this.limit,used:this.clients.size,connected:sessions.filter(r=>!r.session.modoDiagnostico&&r.session.estado===3&&!r.session.requiereRevision&&(r.session.accesoCompletado||r.session.aparecido&&r.session.loginPasos===r.session.loginTotal)).length,memoryMiB:this.memory()},marketOwner:this.marketOwner?.profile.nickname||null,wireguard:this.vpn?.info()??null};
  }
  async close(){
    this.closed=true;
    await Promise.allSettled([...this.clients.values()].map(async c=>{try{await c.disconnect();}finally{await c.worker.close();c.dispose();}}));
    this.clients.clear();this.marketOwner=null;
  }
}
module.exports={SessionManager,SessionError};
