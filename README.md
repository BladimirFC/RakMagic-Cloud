# RakMagic Cloud

Versión 0.6.8: diagnóstico de interfaz con prueba de negociación manual.
El arranque de cuentas, el login automático, la reconexión y AFK están
desactivados. Las acciones de interfaz todavía no están implementadas.
Una conexión de red o un spawn no confirman el acceso a una cuenta.
El nuevo inventario registra solo IDs, cantidades y tamaños, incluyendo
los paquetes fuera del canal F4. No guarda cuerpos de paquetes. La única respuesta adicional se envía por orden manual, como se describe a continuación.

## Despliegue en Wispbyte

- Repositorio: `BladimirFC/RakMagic-Cloud`.
- Rama: `main`.
- Carpeta en el servidor: `/` (raíz).
- Actualizar con cada push y **conservar los archivos que no están en el repositorio**.
- Paso de verificación: `cd /home/container && npm run verify`.
- Archivo de arranque, **JS_FILE**: `index-diagnostico.js`.

La ruta antigua de verificación,
`cd /home/container/rakmagic-cloud && npm run verify`, también funciona:
el pequeño paquete de compatibilidad de esa carpeta ejecuta la comprobación
del programa instalado en la raíz. El programa y sus datos están en la raíz.
`index-wispbyte.js` queda como alias de arranque con ese mismo directorio.

Los commits reinician un servidor gratuito si ya está encendido. Si está
apagado, hay que iniciarlo desde el panel. Wispbyte permite seis despliegues
por hora y admite `[skip deploy]` en el mensaje de commit. El historial y la
salida de cada ejecución aparecen en su pestaña GitHub.

## Configuración privada y ejecutables

```text
/home/container/
  .env                         configuración privada existente
  cloud-profile.json           perfil cifrado existente
  state/                       identidad, sesiones y preferencias existentes
  wireguard.conf               configuración VPN privada, si se usa
  index-diagnostico.js          inicio del programa
  app-0.6.8-ui.cjs
  lib/
  bin/                         ejecutables distribuidos por GitHub
  scripts/verify-deploy.cjs
```

Conservar archivos existentes mantiene `.env`, `state` y el perfil cifrado.
No publiques esos archivos, claves, enlaces privados ni capturas de paquetes.
No es necesario volver a exportar el perfil ni activar la VPN al actualizar.

Los programas nativos se ejecutan desde copias verificadas por SHA-256 en
el directorio temporal del contenedor. GitHub puede actualizar los originales
de `bin/` mientras una copia está funcionando. Los ejecutables antiguos de la
raíz quedan sin utilizar después del reinicio.

## Uso

```text
interfaz estado
interfaz diagnostico Nombre_Apellido
interfaz canales Nombre_Apellido
conexion diagnostico Nombre_Apellido
vpn estado
```

Estas consultas no conectan cuentas. La conexión requiere una orden manual.
Este programa no reproduce verificaciones de autenticación del launcher
oficial ni ejecuta sus DLL.

## Prueba manual del inventario F4

`interfaz negociar Nombre_Apellido` responde a una solicitud F4 ya recibida
con una lista vacía de interfaces predefinidas. Se permite un solo intento
por conexión, únicamente mientras esa cuenta tiene conexión de juego.
Observar la solicitud no envía nada automáticamente. Este comando no conecta
cuentas, no introduce la clave, no pulsa botones ni activa AFK.
Si ya hay un diálogo SA-MP abierto, el comando no envía el inventario.
El diagnóstico conserva los últimos ocho diálogos visibles y saneados para
que un aviso de desconexión no oculte una pantalla de login anterior.

Tras conectar manualmente la cuenta, espera a que aparezca el servidor y
reciba la operación F4 5, ejecuta el comando y consulta `interfaz canales`
para comprobar si el servidor entrega una pantalla o un aviso diferente.
`negociacion.respuestasEnviadas` significa que la respuesta entró en la cola
local de envío; la aceptación remota permanece sin confirmar. Este cliente
no anuncia interfaces predefinidas que no tiene implementadas.

## Desarrollo

Node.js 22 o posterior, Linux x86-64 y glibc 2.36 o posterior.
Los binarios y las dependencias vendorizadas ya están incluidos.

```sh
npm test
npm run verify
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
cp build/rakmagic-worker bin/rakmagic-worker-0.6.8-ui
strip bin/rakmagic-worker-0.6.8-ui
cd wireguard
CGO_ENABLED=0 go build -mod=vendor -trimpath -ldflags='-s -w' -o ../bin/rakmagic-wireguard-0.6.5 .
cd ..
node scripts/update-manifest.cjs
npm run verify
```

Los cambios nativos requieren actualizar el binario y su manifiesto en el
mismo commit. `npm start` usa esta misma carpeta para los datos del programa.
Licencia: GPL-2.0-or-later. Consulta `COPYING`, los archivos `LICENSE-*` y
`THIRD-PARTY-WIREGUARD.md` para las dependencias y sus atribuciones.
