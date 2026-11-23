# RakMagic Cloud

Versión 0.6.9: acceso grabado al conectar una cuenta manualmente.
Usa los diálogos SA-MP normales recibidos del servidor. El historial real
confirmó que llega el diálogo **Confirmar cuenta**; no necesita negociar F4
para responderlo. Este programa no acredita el uso del launcher oficial.

## Uso en Wispbyte

- Repositorio: `BladimirFC/RakMagic-Cloud`, rama `main`.
- Carpeta: `/`, conservando los archivos que no están en el repositorio.
- Verificación: `cd /home/container && npm run verify`.
- Archivo de arranque **JS_FILE**: `index-diagnostico.js` (se mantiene el nombre).

La ruta antigua `cd /home/container/rakmagic-cloud && npm run verify`
también funciona mediante el paquete de compatibilidad de esa carpeta.
`index-wispbyte.js` es otro punto de entrada con el mismo modo de acceso.

```text
interfaz estado
conectar Nombre_Apellido
estado
interfaz canales Nombre_Apellido
desconectar Nombre_Apellido
```

El estado inicial muestra `modo: login-grabado`, `loginAutomatico: true`,
`arranqueAutomatico: false` y `afkAutomatico: false`.
No se restauran cuentas al arrancar. La orden de conexión inicia el acceso
con la clave del perfil cifrado existente, sin solicitarla por la consola.

## Condiciones del acceso grabado

Antes de aceptar **Si, es mia**, se comprueba que el usuario y el personaje
indicados por el servidor correspondan a la cuenta elegida. Los pasos
posteriores usan el recorrido exportado desde RakMagic y controles visibles
que coincidan con él. Las claves solo se envían en campos de diálogo
reconocidos; no se envían como chat ni se realizan registros o cambios de clave.
Cada conexión admite una clave de cuenta y, si se solicita y está configurada,
una verificación de nueva IP. Las solicitudes repetidas detienen el acceso.

Si el recorrido termina antes de un botón **Jugar** visible y único, puede
pulsarlo una vez para el personaje verificado. No se eligen personajes
ambiguos. La entrada se marca completa al terminar los pasos, cerrar los
controles de login y recibir otra aparición autorizada después de enviar la
clave. La aparición inicial, anterior al formulario, no confirma acceso.

AFK, mercado, rutas y reconexión automática permanecen desactivados en este
modo. Una pantalla inesperada o un envío fallido detienen el acceso sin
volver a enviar credenciales. `interfaz canales` conserva ocho diálogos
saneados por intento, además del inventario de paquetes y mensajes visibles.
La negociación manual F4 de las versiones de diagnóstico queda desactivada.

## Archivos privados

Conservar `.env`, `cloud-profile.json` y `state/` en la raíz mantiene la
identidad, perfil cifrado, sesiones y preferencias. No publiques estos
archivos, claves privadas, configuraciones VPN o enlaces de control.
Los ejecutables distribuidos están en `bin/` y se ejecutan desde copias
inmutables para permitir nuevas actualizaciones con el proceso en marcha.
WireGuard conserva la opción de la configuración privada existente.

## Desarrollo

Node.js 22 o posterior, Linux x86-64 y glibc 2.36 o posterior.

```sh
npm test
npm run verify
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
cp build/rakmagic-worker bin/rakmagic-worker-0.6.9-ui
strip bin/rakmagic-worker-0.6.9-ui
node scripts/update-manifest.cjs
npm run verify
```

Los binarios y sus fuentes están incluidos; Wispbyte no necesita compilarlos.
Actualiza el manifiesto y el ejecutable en el mismo commit si cambia el código
nativo. Licencia GPL-2.0-or-later; consulta `COPYING`, `LICENSE-*` y
`THIRD-PARTY-WIREGUARD.md` para las dependencias y sus atribuciones.
