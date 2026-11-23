'use strict';
require('./app-0.6.9-ui.cjs').main({afkOnly:true,nativeUiDiagnostics:true,diagnosticOnly:true,recordedLogin:true}).catch(()=>{
  console.error('No se pudo iniciar el diagnostico de interfaz nativa.');process.exitCode=1;
});
