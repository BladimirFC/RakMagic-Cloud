'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),https=require('node:https');
const {Pairing}=require('./pairing-0.6.0.cjs');
// Small DER encoder for a self-signed TLS certificate using the existing host identity.
const der=(tag,...parts)=>{const value=Buffer.concat(parts.map(v=>Buffer.isBuffer(v)?v:Buffer.from(v))),n=value.length,b=[];if(n<128)b.push(n);else{let size=n;while(size){b.unshift(size&255);size>>>=8;}b.unshift(128|b.length);}return Buffer.concat([Buffer.from([tag,...b]),value]);};
const seq=(...v)=>der(48,...v),integer=n=>der(2,Buffer.from(n)),algorithm=seq(Buffer.from('06092a864886f70d01010b0500','hex'));
function certificate(key){
  const name=seq(der(49,seq(Buffer.from('0603550403','hex'),der(12,'RakMagic Cloud'))));
  const publicDer=key.publicKey.export({type:'spki',format:'der'}),serial=crypto.createHash('sha256').update(publicDer).digest().subarray(0,16);
  const tbs=seq(der(160,integer([2])),integer(serial[0]&128?[0,...serial]:[...serial]),algorithm,name,
    seq(der(24,'20260101000000Z'),der(24,'20460101000000Z')),name,key.publicKey.export({type:'spki',format:'der'}));
  const signed=seq(tbs,algorithm,der(3,Buffer.from([0]),crypto.sign('sha256',tbs,key.privateKey)));
  return '-----BEGIN CERTIFICATE-----\n'+signed.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n';
}
function writeJson(file,data){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(data)+'\n',{mode:0o600});fs.renameSync(temp,file);}
class MarketFeed {
  constructor(directory){
    this.file=path.join(directory,'state/market-feed.json');this.data={v:1,epoch:crypto.randomUUID(),sequence:0,events:[],offers:[],status:'Pendiente de la primera revision',lastScanAt:null};
    try{const old=JSON.parse(fs.readFileSync(this.file,'utf8'));if(old.v===1&&typeof old.epoch==='string'&&Number.isSafeInteger(old.sequence)&&Array.isArray(old.events)&&old.events.length<=1000&&Array.isArray(old.offers))this.data=old;}catch(_){}
  }
  save(){writeJson(this.file,this.data);}
  status(text){this.data.status=text;this.save();}
  complete(offers,now=new Date()){
    const time=now.toISOString(),review=crypto.randomUUID();
    this.data.offers=offers.map(o=>({...o,checkedAt:o.checkedAt||time}));this.data.lastScanAt=time;this.data.status=offers.length+' cajas rentables en la ultima revision';
    for(const offer of this.data.offers)this.data.events.push({...offer,id:++this.data.sequence,review,createdAt:time});
    this.data.events=this.data.events.slice(-1000);this.save();
  }
  read(after=0){
    const events=this.data.events.filter(o=>o.id>after).slice(0,100);
    return {v:1,epoch:this.data.epoch,events,next:events.at(-1)?.id??this.data.sequence,more:events.length>0&&events.at(-1).id<this.data.sequence,offers:this.data.offers,status:this.data.status,lastScanAt:this.data.lastScanAt};
  }
}
async function serveFeed(directory,key,feed,address,control=null){
  const endpoint=new URL(address);
  if(endpoint.protocol!=='https:'||!endpoint.hostname||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw Error('Direccion de avisos no valida');
  const port=Number(endpoint.port||443);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Puerto no valido');
  const tokenFile=path.join(directory,'state/market-token.txt');
  if(!fs.existsSync(tokenFile))fs.writeFileSync(tokenFile,crypto.randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'});
  fs.chmodSync(tokenFile,0o600);const token=fs.readFileSync(tokenFile,'utf8').trim();if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('Token de avisos no valido');
  const tokenHash=crypto.createHash('sha256').update('Bearer '+token).digest();
  let controlToken,controlHash;
  if(control){
    const file=path.join(directory,'state/control-token.txt');
    if(!fs.existsSync(file))fs.writeFileSync(file,crypto.randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'});
    fs.chmodSync(file,0o600);controlToken=fs.readFileSync(file,'utf8').trim();
    if(!/^[A-Za-z0-9_-]{43}$/.test(controlToken)||controlToken===token)throw Error('Token de control no valido');
    controlHash=crypto.createHash('sha256').update('Bearer '+controlToken).digest();
  }
  const controlLink=control?{v:1,kind:'rakmagic-control-link',endpoint:endpoint.origin,publicKey:key.publicKey.export({type:'spki',format:'der'}).toString('base64'),fingerprint:key.fingerprint,token:controlToken}:null;
  const pairing=controlLink?new Pairing(controlLink):null;
  const readBody=(req,res,maximum,run)=>{
    if(req.headers['content-type']!=='application/json'){res.writeHead(415).end('{}');return;}
    if(req.headers['content-length']&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>maximum)){res.writeHead(413).end('{}');return;}
    let size=0,parts=[],oversized=false;
    req.on('data',part=>{size+=part.length;if(size>maximum){oversized=true;parts=[];if(!res.writableEnded)res.writeHead(413).end('{}');}else if(!oversized)parts.push(part);});
    req.on('error',()=>{if(!res.writableEnded)res.writeHead(400).end('{}');});
    req.on('end',()=>{
      if(oversized||res.writableEnded)return;
      let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch(_){res.writeHead(400).end('{}');return;}
      Promise.resolve().then(()=>run(body)).then(result=>{if(!res.destroyed&&!res.writableEnded)res.writeHead(result.code).end(JSON.stringify(result.body));}).catch(()=>{if(!res.destroyed&&!res.writableEnded)res.writeHead(500).end('{}');});
    });
  };
  const server=https.createServer({key:key.privateKey.export({type:'pkcs8',format:'pem'}),cert:certificate(key),minVersion:'TLSv1.2',maxHeaderSize:4096},(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-RakMagic-Version','0.6.0');
    let u;try{u=new URL(req.url,'https://localhost');}catch(_){res.writeHead(400).end('{}');return;}
    if(u.pathname==='/pair'&&pairing){
      if(req.method==='GET'){
        if(u.searchParams.get('v')!=='2'){res.writeHead(426).end(JSON.stringify({message:'Actualiza RakMagic a 1.6.1 para vincular con seis digitos.'}));return;}
        if([...u.searchParams.keys()].some(key=>!['v','nonce','A'].includes(key))||['v','nonce','A'].some(key=>u.searchParams.getAll(key).length!==1)){res.writeHead(400).end('{}');return;}
        const result=pairing.info(u.searchParams.get('nonce'),u.searchParams.get('A'));res.writeHead(result.code).end(JSON.stringify(result.body));return;
      }
      if(req.method==='POST'&&!u.search){readBody(req,res,512,body=>pairing.finish(body));return;}
      res.writeHead(405).end('{}');return;
    }
    const hash=crypto.createHash('sha256').update(String(req.headers.authorization||'')).digest();
    if(u.pathname==='/map'&&control?.map){
      if(!crypto.timingSafeEqual(hash,controlHash)){res.writeHead(401).end('{}');return;}
      if(u.search){res.writeHead(400).end('{}');return;}
      if(req.method==='GET'){try{res.end(JSON.stringify(control.map.snapshot()));}catch(_){res.writeHead(503).end(JSON.stringify({message:'No se pudo actualizar el mapa del hosting.'}));}return;}
      if(req.method==='POST'){readBody(req,res,8192,body=>control.map.execute(body));return;}
      res.writeHead(405).end('{}');return;
    }
    if(u.pathname==='/screen'&&control?.menus){
      if(!crypto.timingSafeEqual(hash,controlHash)){res.writeHead(401).end('{}');return;}
      if(req.method==='GET'){
        if([...u.searchParams.keys()].some(key=>!['nickname','lease'].includes(key))||u.searchParams.getAll('nickname').length!==1||u.searchParams.getAll('lease').length>1){res.writeHead(400).end('{}');return;}
        const lease=u.searchParams.get('lease');
        if(lease&&!/^[A-Za-z0-9_-]{32}$/.test(lease)){res.writeHead(400).end('{}');return;}
        try{res.end(JSON.stringify(control.menus.screen(u.searchParams.get('nickname'),lease)));}
        catch(_){res.writeHead(409).end(JSON.stringify({message:'Esa cuenta no esta disponible. Actualiza el control del hosting.'}));}return;
      }
      if(req.method==='POST'&&!u.search){readBody(req,res,8192,body=>control.menus.execute(body));return;}
      res.writeHead(405).end('{}');return;
    }
    if(u.pathname==='/profile'&&control){
      if(!crypto.timingSafeEqual(hash,controlHash)){res.writeHead(401).end('{}');return;}
      if(u.search||req.method!=='POST'){res.writeHead(405).end('{}');return;}
      if(typeof control.installProfile!=='function'){res.writeHead(503).end('{}');return;}
      readBody(req,res,1048576,body=>control.installProfile(body));return;
    }
    if(u.pathname==='/control'&&control){
      if(!crypto.timingSafeEqual(hash,controlHash)){res.writeHead(401).end('{}');return;}
      if(u.search){res.writeHead(400).end('{}');return;}
      if(req.method==='GET'){res.end(JSON.stringify(control.status()));return;}
      if(req.method!=='POST'){res.writeHead(405).end('{}');return;}
      if(req.headers['content-type']!=='application/json'){res.writeHead(415).end('{}');return;}
      if(req.headers['content-length']&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>512)){res.writeHead(413).end('{}');return;}
      let size=0,parts=[],oversized=false;
      req.on('data',part=>{size+=part.length;if(size>512){oversized=true;parts=[];if(!res.writableEnded)res.writeHead(413).end('{}');}else if(!oversized)parts.push(part);});
      req.on('error',()=>{if(!res.writableEnded)res.writeHead(400).end('{}');});
      req.on('end',()=>{
        if(oversized||res.writableEnded)return;
        let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch(_){res.writeHead(400).end('{}');return;}
        control.execute(body).then(result=>{if(!res.destroyed)res.writeHead(result.code).end(JSON.stringify(result.body));}).catch(()=>{if(!res.destroyed)res.writeHead(500).end('{}');});
      });return;
    }
    if(req.method!=='GET'){res.writeHead(405).end('{}');return;}
    if(!crypto.timingSafeEqual(hash,tokenHash)){res.writeHead(401).end('{}');return;}
    if(u.pathname!=='/market'||![...u.searchParams.keys()].every(k=>k==='after')||!/^\d{1,16}$/.test(u.searchParams.get('after')||'0')){res.writeHead(404).end('{}');return;}
    const after=Number(u.searchParams.get('after')||0);if(!Number.isSafeInteger(after)){res.writeHead(400).end('{}');return;}
    res.end(JSON.stringify(feed.read(after)));
  });
  server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;server.maxConnections=20;server.on('tlsClientError',()=>{});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  server.on('error',()=>{});
  writeJson(path.join(directory,'market-link.json'),{v:1,kind:'rakmagic-market-link',endpoint:endpoint.origin,publicKey:key.publicKey.export({type:'spki',format:'der'}).toString('base64'),fingerprint:key.fingerprint,token});
  if(control)writeJson(path.join(directory,'control-link.json'),controlLink);
  server.pairing=pairing;
  return server;
}
module.exports={MarketFeed,serveFeed,certificate};
