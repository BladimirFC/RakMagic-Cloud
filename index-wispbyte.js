'use strict';
const path=require('node:path');
// Wispbyte deploys into /home/container and retains its private runtime files.
require('./app-0.6.7-ui.cjs').main({
  afkOnly:true,nativeUiDiagnostics:true,diagnosticOnly:true,
  dataDirectory:path.resolve(__dirname)
}).catch(()=>{
  console.error('No se pudo iniciar el diagnostico de interfaz nativa.');
  process.exitCode=1;
});
