# RakMagic Cloud

Versión 0.6.6: diagnóstico pasivo de la interfaz nativa del servidor.
Permite vincular RakMagic y consultar los mensajes de interfaz recibidos.
El arranque de cuentas, el login automático, la reconexión y AFK están
desactivados. Las acciones de interfaz todavía no están implementadas.
Una conexión de red o un spawn no confirman el acceso a una cuenta.

## Despliegue en Wispbyte

En **GitHub → Desplegar un repositorio**, selecciona:

- Repositorio: `BladimirFC/RakMagic-Cloud`.
- Rama: `main`.
- Carpeta de destino: `/rakmagic-cloud`.
- Actualizar con cada push y **conservar los archivos que no están en el repositorio**.
- Instalación: no necesita descargar paquetes de npm.
- Comprobación opcional: `cd /home/container/rakmagic-cloud && npm run verify`.

Cuando termine la primera descarga, cambia **Startup → JS_FILE** a
`rakmagic-cloud/index-wispbyte.js`. Si Wispbyte solicita un comando de
ejecución para el despliegue, usa
`node /home/container/rakmagic-cloud/index-wispbyte.js`.

Los commits reinician un servidor gratuito si ya está encendido. Si está
apagado, hay que iniciarlo desde el panel. Wispbyte permite seis despliegues
por hora en el plan gratuito y admite `[skip deploy]` en el mensaje de commit.
El historial y la salida de cada ejecución aparecen en la pestaña GitHub.

## Datos que deben conservarse en el hosting

```text
/home/container/
  .env                         configuración privada existente
  cloud-profile.json           perfil cifrado existente
  state/                       identidad privada, sesiones y preferencias
  wireguard.conf               configuración VPN privada, si se usa
  rakmagic-cloud/              código descargado de este repositorio
    index-wispbyte.js
    app-0.6.6-ui.cjs
    rakmagic-worker-0.6.6-ui
    rakmagic-wireguard-0.6.5
    lib/
```

`index-wispbyte.js` busca la configuración y los datos en la carpeta padre.
Los ejecutables se leen de la carpeta del código. Así las actualizaciones
mantienen la identidad del hosting y no requieren exportar otra vez el login.
No publiques `.env`, `state`, perfiles, claves, enlaces privados ni capturas
de paquetes. El repositorio incluye únicamente código y ejemplos vacíos.

## Uso

```text
interfaz estado
interfaz diagnostico Nombre_Apellido
conexion diagnostico Nombre_Apellido
vpn estado
```

Estas consultas no conectan cuentas. La conexión requiere una orden manual.
WireGuard conserva la opción de la configuración privada del hosting; no se
activa al desplegar esta versión. Este programa no reproduce verificaciones
de autenticación del launcher oficial ni ejecuta sus DLL.

## Desarrollo

Node.js 22 o posterior, Linux x86-64 y glibc 2.36 o posterior.
Los binarios ya están incluidos, por lo que Wispbyte no necesita compilarlos.

```sh
npm test
npm run verify
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
cp build/rakmagic-worker rakmagic-worker-0.6.6-ui
strip rakmagic-worker-0.6.6-ui
cd wireguard
CGO_ENABLED=0 go build -mod=vendor -trimpath -ldflags='-s -w' -o ../rakmagic-wireguard-0.6.5 .
cd ..
node scripts/update-manifest.cjs
npm run verify
```

El helper WireGuard conserva sus fuentes y dependencias vendorizadas.
Los cambios de código nativo requieren actualizar el ejecutable correspondiente
en el mismo commit. Para uso fuera de Wispbyte, `npm start` usa esta propia
carpeta para sus datos, en lugar de la carpeta padre.

Licencia: GPL-2.0-or-later. Consulta `COPYING`, los archivos `LICENSE-*` y
`THIRD-PARTY-WIREGUARD.md` para las dependencias y sus atribuciones.
