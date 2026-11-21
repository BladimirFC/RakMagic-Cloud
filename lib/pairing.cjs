'use strict';
const crypto=require('node:crypto');
const {SRP,SrpServer}=require('./vendor/fast-srp-hap/lib/srp.js');
const identity=(link,nonce)=>Buffer.from(JSON.stringify(['rakmagic-pair-srp-v2',link.endpoint,link.publicKey,nonce]));
class Pairing {
  constructor(link,{now=Date.now}={}){this.link=link;this.now=now;this.cancel();}
  cancel(){this.code=null;this.expires=0;this.attempts=0;this.issued=0;this.sessions=new Map();}
  open(){this.cancel();this.code=crypto.randomInt(0,1000000).toString().padStart(6,'0');this.expires=this.now()+10*60000;return this.code;}
  active(){return this.code!==null&&this.now()<this.expires&&this.attempts<6;}
  info(nonce,A){
    if(!this.active())return {code:410,body:{message:'Usa vincular en la consola para generar un codigo de seis digitos.'}};
    if(typeof nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(nonce)||typeof A!=='string'||!/^[A-Za-z0-9_-]{342}$/.test(A))return {code:400,body:{message:'Solicitud de vinculacion incompleta.'}};
    if(this.issued>=12)return {code:429,body:{message:'Genera otro codigo con vincular.'}};
    ++this.issued;
    try{
      const salt=crypto.randomBytes(16),srp=new SrpServer(SRP.params[2048],salt,identity(this.link,nonce),Buffer.from(this.code),crypto.randomBytes(32));
      srp.setA(Buffer.from(A,'base64url'));
      const session=crypto.randomBytes(16).toString('base64url');
      for(const [key,value] of this.sessions)if(value.expires<=this.now())this.sessions.delete(key);
      this.sessions.set(session,{srp,expires:this.now()+90000});
      return {code:200,body:{v:2,version:'0.6.0',session,endpoint:this.link.endpoint,publicKey:this.link.publicKey,fingerprint:this.link.fingerprint,nonce,salt:salt.toString('base64url'),B:srp.computeB().toString('base64url')}};
    }catch(_){return {code:400,body:{message:'Solicitud de vinculacion no valida.'}};}
  }
  finish(body){
    if(!this.active())return {code:410,body:{message:'El codigo vencio o se agotaron sus intentos. Usa vincular para generar otro.'}};
    if(!body||body.v!==2||Object.keys(body).length!==3||typeof body.session!=='string'||!/^[A-Za-z0-9_-]{22}$/.test(body.session)||typeof body.proof!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.proof))return {code:400,body:{}};
    const session=this.sessions.get(body.session);this.sessions.delete(body.session);
    if(!session||session.expires<=this.now())return {code:409,body:{message:'Repite la vinculacion desde la app.'}};
    ++this.attempts;
    try{session.srp.checkM1(Buffer.from(body.proof,'base64url'));}
    catch(_){return {code:401,body:{message:'Codigo de vinculacion incorrecto.'}};}
    const result={v:2,link:{...this.link},proof:session.srp.computeM2().toString('base64url')};
    this.cancel();return {code:200,body:result};
  }
}
module.exports={Pairing};
