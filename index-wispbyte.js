'use strict';
const path=require('node:path');
// Code is deployed into /rakmagic-cloud; private files stay in its parent.
require('./app-0.6.6-ui.cjs').main({
  afkOnly:true,nativeUiDiagnostics:true,diagnosticOnly:true,
  dataDirectory:path.resolve(__dirname,'..')
}).catch(()=>{
  console.error('No se pudo iniciar el diagnostico de interfaz nativa.');
  process.exitCode=1;
});
