'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const files={};
for(const name of ['rakmagic-worker-0.6.6-ui','rakmagic-wireguard-0.6.5']){
  const bytes=fs.readFileSync(path.join(root,name));
  files[name]={bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
fs.writeFileSync(path.join(root,'deployment-manifest.json'),JSON.stringify({
  version:'0.6.6',mode:'read-only',entrypoint:'index-wispbyte.js',dataDirectory:'..',
  automaticAccountStart:false,experimentalLauncherAuthentication:false,files
},null,2)+'\n');
