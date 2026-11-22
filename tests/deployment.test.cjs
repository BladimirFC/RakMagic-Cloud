'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {WireGuard}=require('../lib/wireguard.cjs');
const root=path.resolve(__dirname,'..');
test('Wispbyte entrypoint keeps existing private state at the server root and starts no accounts',()=>{
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'rakmagic-deploy-'));
  try{
    const code=runtime;
    for(const name of ['index-wispbyte.js','app-0.6.7-ui.cjs','lib','bin'])
      fs.cpSync(path.join(root,name),path.join(code,name),{recursive:true});
    fs.writeFileSync(path.join(runtime,'.env'),'RAKMAGIC_WG_ENABLED=0\n');
    fs.mkdirSync(path.join(runtime,'state'));
    fs.writeFileSync(path.join(runtime,'state/keep.txt'),'existing state');
    const result=spawnSync(process.execPath,[path.join(code,'index-wispbyte.js')],{
      input:'interfaz estado\nvpn estado\nsalir\n',encoding:'utf8',timeout:20000,
      env:{PATH:process.env.PATH,RAKMAGIC_WG_ENABLED:'0'}
    });
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
    assert.match(result.stdout,/"cuentasActivas": 0/);
    assert.match(result.stdout,/"loginAutomatico": false/);
    assert.match(result.stdout,/WireGuard desactivado/);
    assert.doesNotMatch(result.stdout,/Conectando a /);
    assert.ok(fs.existsSync(path.join(runtime,'state/host-key.pem')));
    assert.ok(fs.existsSync(path.join(runtime,'host-key.json')));
    assert.equal(fs.readFileSync(path.join(runtime,'state/keep.txt'),'utf8'),'existing state');
  }finally{fs.rmSync(runtime,{recursive:true,force:true});}
});
test('WireGuard resolves private configuration and program binary independently',()=>{
  const wg=new WireGuard('/runtime',{enabled:false,binaryDirectory:'/code',file:'private.conf'});
  assert.equal(wg.file,path.resolve('/runtime/private.conf'));
  assert.equal(wg.binaryDirectory,path.resolve('/code'));
  assert.equal(wg.info().activado,false);
});
