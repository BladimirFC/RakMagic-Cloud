'use strict';
const {normalize}=require('./automation.cjs');
const clean=value=>normalize(String(value??'').replace(/_/g,' '));
const fold=value=>clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const money=value=>/^(?:[1-9]\d*|0|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)&&Number.isSafeInteger(Number(value.replace(/,/g,'')))?Number(value.replace(/,/g,'')):null;
function boxRow(value){
  const label=clean(value),m=/^Box P\. Armadura \(([1-9]\d{0,5}) unidades\)\s+\$([0-9,]+)$/i.exec(label);
  if(!m)return null;
  const quantity=Number(m[1]),price=money(m[2]);
  if(price===null||price<=0||price>2147483647)return null;
  return {label,quantity,price,unitPrice:price/quantity,unitProfit:700-price/quantity,profit:quantity*700-price,profitable:price<=quantity*600};
}
function boxDetails(dialog){
  if(!dialog||fold(dialog.title)!=='detalles del articulo'||fold(dialog.yes)!=='comprar'||fold(dialog.no)!=='volver'||dialog.style!==0)return null;
  const lines=String(dialog.body).split('\n').map(clean);
  const field=regex=>{const matches=lines.map(s=>regex.exec(s)).filter(Boolean);return matches.length===1?matches[0]:null;};
  const id=field(/^Publicidad #([1-9]\d{0,9})$/),category=field(/^Categor[ií]a: (.+)$/i),object=field(/^Objeto: (.+)$/i),price=field(/^Precio de venta: \$([0-9,]+)$/i),quantity=field(/^Cantidad: ([1-9]\d{0,5})(?: unidades)?$/i);
  if(!id||!category||fold(category[1])!=='objetos ilegales'||!object||!price||!quantity)return null;
  const offer=boxRow(object[1]+' $'+price[1]);
  if(!offer||offer.quantity!==Number(quantity[1]))return null;
  return {...offer,advertId:id[1]};
}
const cuba=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Havana',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function schedule(date=new Date()){
  const parts=cuba.formatToParts(date),hour=Number(parts.find(p=>p.type==='hour').value),minute=Number(parts.find(p=>p.type==='minute').value);
  const interval=hour>=7?30:60,elapsed=(minute%interval)*60000+date.getUTCSeconds()*1000+date.getUTCMilliseconds();
  return {slot:date.getTime()-elapsed,intervalMinutes:interval,next:date.getTime()-elapsed+interval*60000};
}
function rows(dialog){return String(dialog.body).split('\n').map((value,index)=>({value:clean(value),index:index-(dialog.style===5?1:0)})).filter(r=>r.index>=0&&r.value);}
function isList(d){return d&&[2,4,5].includes(d.style)&&fold(d.title)==='placas de armadura'&&fold(d.yes)==='detalles'&&fold(d.no)==='volver';}
function menu(d,kind){
  return d&&[2,4,5].includes(d.style)&&fold(d.yes)==='continuar'&&['volver','atras'].includes(fold(d.no))&&
    (kind==='illegal'?/^articulos ilegales(?:\s*:\s*\d+)?$/.test(fold(d.title)):/^categoria\s*:\s*objetos ilegales$/.test(fold(d.title)));
}
function rowChoice(d,label){
  const matched=rows(d).filter(r=>fold(r.value).replace(/^\[\d+\]\s*/,'').replace(/\s*:\s*\d+$/,'')===label);
  return matched.length===1?matched[0]:null;
}
function validateButton(p){
  if(!p||p.v!==1||p.kind!=='rakmagic-market-button'||!p.button||typeof p.button.text!=='string'||p.button.text.length>1024||!Number.isInteger(p.button.style)||p.button.style<0||p.button.style>5||!Number.isFinite(p.button.x)||!Number.isFinite(p.button.y)||Math.abs(p.button.x)>100000||Math.abs(p.button.y)>100000)throw Error('Boton no valido');
  return p.button;
}
const stages={open:'abrir /mc',root:'menu principal / boton Mercado Ilegal',illegal:'categorias del mercado ilegal',objects:'objetos ilegales / placas',list:'lista de placas',choose:'seleccionar caja',details:'detalles de la caja',return:'volver a la lista',cleanup:'cerrar menus',idle:'en espera'};
class MarketScanner {
  constructor(driver,{onOffer=()=>{},onComplete=()=>{},onStatus=()=>{},onDiagnostic=()=>{},button=null}={}){
    this.driver=driver;this.onOffer=onOffer;this.onComplete=onComplete;this.onStatus=onStatus;this.onDiagnostic=onDiagnostic;this.button=button;this.phase='idle';this.lastAction=-Infinity;this.seen=new Set();this.offers=[];this.lastSlot=null;this.generation=0;this.lastDiagnostic=null;
  }
  get active(){return this.phase!=='idle';}
  start(now=Date.now()){
    if(this.active)return false;
    this.generation++;this.phase='open';this.started=now;this.notBefore=now;this.deadline=now+30000;this.seen.clear();this.offers=[];this.candidates=[];this.index=0;this.failure='';this.rootSignature='';this.rootReopened=false;this.openedAt=null;this.quietSince=null;this.cleanupStarted=null;this.messages=[];this.stats=null;return true;
  }
  observeLog(text){if(this.active&&/mercado|placa|comando|afk|esper|segundo|no puedes|selecci|pantalla/i.test(fold(text)))this.messages=[...(this.messages||[]),String(text)].slice(-6);}
  diagnose(reason,now){
    const s=this.lastSnapshot||{},draws=[...(s.textdraws?.values()||[])];
    const pick=td=>({id:td.id,revision:td.revision,text:td.text,style:td.style,x:td.x,y:td.y,selectable:td.selectable});
    const d=s.dialog;
    const info={v:1,time:new Date(now).toISOString(),phase:this.phase,stage:stages[this.phase],reason,selectionActive:s.selecting===true,rootReopened:this.rootReopened,button:this.button,buttons:draws.filter(td=>td.selectable).slice(0,40).map(pick),marketLabels:draws.filter(td=>/mercado|ilegal|publicar|placas/i.test(fold(td.text))).slice(0,24).map(pick),dialog:d?{title:d.title,style:d.style,yes:d.yes,no:d.no,body:d.body}:null,serverMessages:this.messages||[],stats:this.stats};
    this.lastDiagnostic=info;this.onDiagnostic(info);return info;
  }
  beginCleanup(now){this.phase='cleanup';this.cleanupStarted=now;this.deadline=now+15000;this.quietSince=null;}
  fail(reason,now,diagnose=true){if(diagnose)this.diagnose(reason,now);this.generation++;this.failure=reason;this.beginCleanup(now);this.onStatus(reason);}
  reset(){this.generation++;this.phase='idle';this.offers=[];this.seen.clear();}
  async action(now,run,next){
    if(now-this.lastAction<2100)return false;
    this.lastAction=now;const generation=this.generation,ok=await run();
    if(this.generation!==generation)return false;
    if(!ok){this.fail('No se pudo confirmar una accion del mercado; revision detenida.',now);return false;}
    this.phase=next;this.deadline=next==='cleanup'?(this.cleanupStarted??now)+15000:now+30000;this.quietSince=null;return true;
  }
  async reply(s,d,yes,item,value,now,next){
    return this.action(now,async()=>{const ok=await this.driver.reply(d.serial,d.id,yes,item,value);if(ok&&s.dialog?.serial===d.serial)s.dialog=null;return ok;},next);
  }
  async pump(s,now=Date.now()){
    if(!this.active)return;
    this.lastSnapshot=s;
    if(s.state!==3){this.reset();return;}
    if(now-this.started>15*60000){this.diagnose('Revision del mercado agotada.',now);this.onStatus('Revision del mercado agotada. Consulta mercado diagnostico.');this.reset();return;}
    if(now>=this.deadline){
      if(this.phase==='cleanup'){if(!this.failure){this.diagnose('No se confirmo el cierre de los menus.',now);this.onStatus('No se confirmo el cierre del mercado. Consulta mercado diagnostico.');}this.reset();return;}
      this.fail('El mercado no mostro la pantalla esperada en '+stages[this.phase]+'. Consulta mercado diagnostico.',now);
    }
    const d=s.dialog;
    switch(this.phase){
      case 'open':
        if(d||s.selecting){this.fail('Hay otra pantalla abierta; esta revision se omite.',now);return;}
        if(await this.action(now,()=>this.driver.send('/mc'),'root')){this.openedAt=now;this.onStatus('Revisando cajas de placas de armadura.');}break;
      case 'root':{
        if(d)break;
        if(!s.selecting){
          // Some menus treat /mc as a toggle: an old open flag can make the
          // first command close it. One fresh open is allowed only with no UI.
          if(!this.rootReopened&&this.openedAt!==null&&now-this.openedAt>=8000){
            this.rootReopened=true;this.rootSignature='';
            if(await this.action(now,()=>this.driver.send('/mc'),'root'))this.onStatus('Mercado: /mc no activo la seleccion; reabriendo una sola vez.');
          }
          break;
        }
        const draws=[...s.textdraws.values()],root=draws.some(td=>/\bilegal(?:es)?\b/.test(fold(td.text)))&&(this.button||draws.some(td=>/\blegal(?:es)?\b|\bpublicar\b/.test(fold(td.text))));
        if(!root)break;
        const matches=draws.filter(td=>td.selectable&&(this.button?
          td.style===this.button.style&&clean(td.text)===clean(this.button.text)&&Math.abs(td.x-this.button.x)<=2&&Math.abs(td.y-this.button.y)<=2:
          fold(td.text)==='mercado ilegal'));
        if(matches.length!==1)break;
        const td=matches[0],signature=JSON.stringify([td.id,td.style,clean(td.text),td.x,td.y]);
        if(signature!==this.rootSignature){this.rootSignature=signature;this.rootStableAt=now+500;break;}
        if(now<this.rootStableAt)break;
        if(await this.action(now,()=>this.driver.click(td.id,td.revision),'illegal'))this.onStatus('Mercado: boton Ilegal enviado; esperando categorias.');break;
      }
      case 'illegal':case 'objects':{
        const phase=this.phase;if(!menu(d,phase==='illegal'?'illegal':'objects'))break;
        const choice=rowChoice(d,phase==='illegal'?'objetos':'placas de armadura');
        if(!choice){this.fail('No hay una opcion unica para las cajas de placas.',now);break;}
        if(await this.reply(s,d,true,choice.index,choice.value,now,phase==='illegal'?'objects':'list'))this.onStatus(phase==='illegal'?'Mercado: Objetos seleccionado.':'Mercado: Placas de Armadura seleccionado.');break;
      }
      case 'list':
        if(!isList(d))break;
        const entries=rows(d).map(r=>({...r,offer:boxRow(r.value)}));
        this.stats={rows:entries.length,boxes:entries.filter(r=>r.offer).length,unknownBoxRows:entries.filter(r=>!r.offer&&/box.*armadura/i.test(r.value)).map(r=>r.value).slice(0,3)};
        if(this.stats.unknownBoxRows.length){this.fail('La lista contiene cajas con un formato no reconocido. Consulta mercado diagnostico.',now);break;}
        this.candidates=entries.filter(r=>r.offer?.profitable);
        this.onStatus('Mercado: '+this.stats.boxes+' cajas leidas; '+this.candidates.length+' cumplen el precio.');
        this.phase='choose';this.deadline=now+30000;break;
      case 'choose':{
        if(!isList(d))break;
        if(this.index>=this.candidates.length){this.beginCleanup(now);break;}
        const wanted=this.candidates[this.index],current=rows(d),atIndex=current.find(r=>r.index===wanted.index&&r.value===wanted.value),matched=current.filter(r=>r.value===wanted.value);
        const choice=atIndex||(matched.length===1?matched[0]:null);
        if(!choice){this.index++;break;}
        this.expected=wanted.offer;
        await this.reply(s,d,true,choice.index,choice.value,now,'details');break;
      }
      case 'details':{
        if(!d)break;
        const offer=boxDetails(d);
        if(!offer){this.fail('Los detalles de la caja cambiaron; no se envio ningun aviso de esa caja.',now);break;}
        // A positive response here would BUY. Only Volver (false) is ever sent.
        if(await this.reply(s,d,false,-1,'',now,'return')){
          if(offer.profitable&&offer.price===this.expected.price&&offer.quantity===this.expected.quantity&&!this.seen.has(offer.advertId)){
            this.seen.add(offer.advertId);this.offers.push({...offer,checkedAt:new Date(now).toISOString()});
          }
        }break;
      }
      case 'return':if(isList(d)){this.index++;this.phase='choose';this.deadline=now+30000;}break;
      case 'cleanup':
        if(d){
          this.quietSince=null;
          if(isList(d)||menu(d,'illegal')||menu(d,'objects')||boxDetails(d))await this.reply(s,d,false,-1,'',now,'cleanup');
          else {this.onStatus('Quedo un dialogo ajeno al mercado; continua manualmente.');this.reset();}
        }else if(s.selecting){this.quietSince=null;await this.action(now,()=>this.driver.cancelSelection(),'cleanup');}
        else {
          if(this.quietSince===null)this.quietSince=now;
          // Worker acknowledgement means the RPC was sent, not that the server
          // has finished responding. Wait through delayed parent-menu replies.
          if(now-this.lastAction<2100||now-this.quietSince<750)break;
          const offers=this.offers.slice(),failed=this.failure;this.reset();
          if(!failed){for(const offer of offers)this.onOffer(offer);this.onComplete(offers);this.onStatus('Revision terminada: '+offers.length+' cajas rentables.');}
        }break;
    }
  }
}
module.exports={boxRow,boxDetails,schedule,MarketScanner,validateButton,fold};
