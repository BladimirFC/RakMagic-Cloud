'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'deployment-manifest.json'),'utf8'));
if(Number(process.versions.node.split('.')[0])<22)throw Error('Se necesita Node.js 22 o posterior.');
for(const [name,expected] of Object.entries(manifest.files)){
  const bytes=fs.readFileSync(path.join(root,name));
  if(bytes.length!==expected.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==expected.sha256)
    throw Error('Archivo incompleto o diferente: '+name);
}
for(const name of ['index-wispbyte.js','app-0.6.8-ui.cjs'])execFileSync(process.execPath,['--check',path.join(root,name)]);
require(path.join(root,'app-0.6.8-ui.cjs'));
console.log('RakMagic 0.6.8: archivos completos; diagnostico manual. No se conectaron cuentas.');
