# Dependencias de WireGuard

El adaptador nuevo utiliza wireguard-go y su netstack en memoria, sin crear una
interfaz del sistema ni modificar sus rutas. Solo admite una configuracion de
un peer; los destinos IPv4 del juego se autorizan desde el supervisor. No es un
proxy publico ni un servidor VPN para otros dispositivos.

Versiones fijadas y huellas de modulos: `wireguard/go.mod` y `wireguard/go.sum`
en el ZIP de fuentes. El ejecutable Go se enlaza estaticamente, sin CGO.

- wireguard-go: MIT.
- gVisor: Apache-2.0.
- google/btree: Apache-2.0.
- Go y golang.org/x/{crypto,net,sys,time}: licencias BSD de tres clausulas.
- El adaptador `wireguard/main.go` nuevo: MIT.

Se incluyen las licencias y avisos de estas dependencias en `LICENSES-wireguard/`.
El codigo C++ del cliente conserva su licencia GPL-2.0-or-later y sus avisos
existentes. El adaptador Go y el cliente nativo son procesos separados que se
comunican mediante un protocolo de datagramas local.
