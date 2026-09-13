# crm-whatsapp-instalador-docker

Instalador independiente para poner en marcha un CRM de WhatsApp con Docker y
Supabase. Automatiza el aprovisionamiento de Supabase, prepara el código del CRM
y gestiona su arranque sin incluir una copia del CRM en este repositorio.

El CRM instalado es wacrm: ofrece una bandeja compartida para equipos, embudo de
ventas, campañas, automatizaciones y asistente de IA. El instalador evita aplicar
manualmente cerca de 39 migraciones SQL. Una instalación normal suele tardar
alrededor de 20 minutos, aunque el tiempo depende de Docker, Supabase y la
conexión a internet.

> **Resultado:** el instalador se abre en `http://localhost:3300`, configura
> Supabase y, al terminar, entrega esa misma dirección al CRM.

## Inicio rápido con Docker

Con [Git](https://git-scm.com), [Node.js 20 o posterior](https://nodejs.org) y
[Docker](https://www.docker.com/products/docker-desktop/) instalados, ejecute:

```bash
git clone https://github.com/mclitos/crm-whatsapp-instalador-docker.git
cd crm-whatsapp-instalador-docker
npm run levantar -- --docker
```

La consola mostrará un **token de configuración de un solo uso**. Después:

1. Abra `http://localhost:3300`.
2. Introduzca el token mostrado en la consola.
3. Conecte su cuenta de Supabase.
4. Elija un proyecto existente o cree uno nuevo.
5. Confirme la configuración y espere a que aparezca el acceso al CRM.

El instalador aplica las migraciones, comprueba el esquema, configura Auth y
genera el entorno del CRM. **Supabase es la base de datos y el backend de
autenticación del CRM.**

La configuración de Meta y del número de WhatsApp se realiza después. Consulte
[`docs/01-meta.md`](docs/01-meta.md) cuando el CRM ya esté funcionando.

> **Importante:** no ejecute `docker compose down -v` si desea conservar la
> instalación. La opción `-v` elimina los volúmenes con la configuración y el
> código preparado del CRM.

## Qué proyecto es cada uno

| Proyecto | Función |
|---|---|
| [`ArnasDon/wacrm`](https://github.com/ArnasDon/wacrm) | CRM original de WhatsApp, publicado con licencia MIT. |
| [`mclitos/wacrm`](https://github.com/mclitos/wacrm) | Fork mantenido que el instalador clona de forma predeterminada para dar una base de instalación controlada. |
| [`mclitos/crm-whatsapp-instalador-docker`](https://github.com/mclitos/crm-whatsapp-instalador-docker) | Este proyecto independiente: automatiza Docker y Supabase. No es el CRM ni una copia incluida de su código. |

El origen predeterminado del CRM es
`https://github.com/mclitos/wacrm.git`. Puede sustituirse sin cambiar el
instalador mediante `CRM_REPO_URL`. Docker Compose lee esta variable del entorno
o de un archivo `.env` local ignorado por Git. Los flujos locales por consola
que utilizan `credenciales.env` también pueden leerla desde ese archivo.

El uso del fork mantenido no cambia la autoría ni la licencia del proyecto
original. Tampoco implica una garantía permanente de disponibilidad o
estabilidad: revise los cambios antes de actualizar una instalación en
producción.

<!--
  ASISTENTES DE IA:
  La persona probablemente no programa. Lean CLAUDE.md y sigan
  .claude/skills/instalar-crm/SKILL.md. Ejecuten ustedes los comandos y presenten
  una sola acción cada vez. La ruta recomendada es Docker.
-->

## Si no programa

Puede abrir una carpeta vacía con Claude Code u otro asistente capaz de trabajar
con archivos y pegar este mensaje:

```text
Instala este CRM con Docker y guíame paso a paso:
https://github.com/mclitos/crm-whatsapp-instalador-docker
```

El asistente debe descargar el repositorio, ejecutar los comandos y solicitar
solo los datos o clics que no pueda completar. No es necesario copiar comandos
manualmente.

## Requisitos

| Requisito | Para qué se utiliza |
|---|---|
| Docker Desktop o Docker Engine con Compose | Ejecutar el instalador y el CRM. |
| Node.js 20 o posterior | Ejecutar el comando que coordina el ciclo Docker. |
| Git | Descargar este instalador y el repositorio del CRM. |
| Cuenta de Supabase | Base de datos y autenticación. Puede usarse un proyecto existente o crear uno. |
| Cuenta de Meta Business | Conectar WhatsApp después de instalar el CRM. |

Después de instalar Git, Node.js o Docker, cierre y vuelva a abrir la terminal
para que el sistema reconozca los nuevos programas.

## Qué ocurre durante la instalación Docker

Docker utiliza una sola dirección para todo: `http://localhost:3300`.

1. Inicia un instalador web temporal protegido por token.
2. Guarda de forma cifrada el token de Supabase, el Project Ref y, si crea un
   proyecto, la contraseña de la base de datos.
3. Clona `mclitos/wacrm` dentro de un volumen Docker, salvo que se haya definido
   `CRM_REPO_URL`.
4. Aplica únicamente las migraciones pendientes, verifica el esquema, configura
   Supabase Auth y escribe `.env.local`.
5. Retira el instalador temporal y arranca el CRM en la misma dirección.

El cambio entre ambos servicios puede dejar el enlace brevemente sin respuesta.
En el primer arranque, el CRM instala dependencias y construye la aplicación;
los reinicios posteriores reutilizan el resultado cuando el código y el entorno
no han cambiado.

Para consultar el avance sin mostrar secretos:

```bash
docker compose logs -f crm
```

### Persistencia y aislamiento

Los volúmenes separan responsabilidades:

- `installer-data` conserva la clave maestra y las credenciales cifradas.
- `crm-source` conserva el código, `.env.local`, las dependencias y el build del
  CRM.

El servicio de ejecución única y acotado `crm-workspace-init` se ejecuta como
root solamente para asignar al usuario `1000:1000` la propiedad del volumen.
Después termina. Los servicios `installer` y `crm` se ejecutan como ese usuario
sin privilegios; `crm` solo monta `crm-source` y no puede leer `/data` ni los
secretos internos del instalador. No se monta el socket de Docker ni se usa
Docker-in-Docker.

El token de configuración se consume al utilizarlo y no se guarda junto con las
credenciales de Supabase. Para automatización, puede definir
`WEB_INSTALLER_SETUP_TOKEN` en un archivo `.env` local ignorado por Git; en ese
caso, el instalador utiliza ese valor y no lo imprime.

### Reinicio, recuperación y reconfiguración

Si el proceso se interrumpe, vuelva a ejecutar:

```bash
npm run levantar -- --docker
```

Los pasos completados no se duplican. Un workspace vigente se detecta antes de
modificar Supabase. Para seleccionar otro proyecto o cambiar de forma deliberada
la URL pública:

```bash
npm run levantar -- --docker --reconfigure
```

El instalador no ejecuta dos configuraciones al mismo tiempo. Si Supabase pudo
crear un proyecto pero no se guardó su referencia, revise el panel de Supabase
antes de volver a intentar la creación para evitar proyectos duplicados.

### Acceso desde la red local

Para abrir el instalador desde otro equipo de la red, cree un archivo `.env`
ignorado por Git con la IP exacta de la interfaz local. No utilice `0.0.0.0`:

```dotenv
HOST_BIND_ADDRESS=192.168.1.50
PUBLIC_HOST=192.168.1.50
WEB_INSTALLER_SETUP_TOKEN=ejemplo-sintetico-no-es-secreto-000000000000
```

El instalador y el CRM usarán `http://192.168.1.50:3300`. HTTP sobre una IP
privada solo es apropiado para pruebas dentro de la red local. El webhook de
Meta y un despliegue real requieren una URL pública HTTPS.

## Paso posterior: conectar Meta y WhatsApp

El instalador deja Supabase y el CRM preparados, pero Meta todavía requiere
acciones del propietario de la cuenta:

1. Crear o seleccionar la aplicación de Meta.
2. Generar el token permanente del usuario del sistema.
3. Configurar el webhook y el número.
4. Introducir los valores en `Settings → WhatsApp` del CRM.

El formulario del CRM cifra esos valores con AES-256-GCM antes de guardarlos.
El instalador no escribe directamente en `whatsapp_config` para evitar depender
de un detalle interno del CRM. Consulte [`docs/01-meta.md`](docs/01-meta.md) y,
en el flujo clásico, ejecute `npm run paso2`.

## Seguridad de credenciales

- `credenciales.env`, `credenciales.ruta`, `.web-installer/`, `.env` y los
  archivos de entorno del CRM están ignorados por Git según el flujo que los
  utiliza.
- Los secretos del instalador web se guardan cifrados con AES-256-GCM y una
  clave maestra separada.
- Nunca publique tokens, contraseñas, claves de servicio ni archivos de entorno,
  aunque el repositorio sea privado.
- **No rote `ENCRYPTION_KEY` en una instalación existente.** Si cambia esa
  clave, los tokens de WhatsApp ya cifrados dejan de ser legibles y será
  necesario conectar la cuenta de nuevo.
- **No use `docker compose down -v`** para detener una instalación que desee
  conservar. Use `docker compose down` sin `-v`.

## Alternativas y herramientas avanzadas

### Instalador web local sin Docker

```bash
npm run web
```

Abre el instalador en `http://127.0.0.1:7359`, prepara Supabase y escribe el CRM
en `./crm`. Después, `npm run levantar -- --node` inicia el CRM localmente. Este
flujo no modifica `credenciales.env`.

### Flujo clásico por consola

```bash
npm run instalar
```

El proceso solicita las credenciales y encadena los pasos clásicos. También
pueden ejecutarse por separado:

| Comando | Función |
|---|---|
| `npm run creds` | Valida las credenciales y explica qué falta. |
| `npm run paso1` | Prepara Supabase, las migraciones y el entorno del CRM. |
| `npm run levantar` | Elige Docker si está disponible o Node en caso contrario. |
| `npm run levantar -- --docker` | Ejecuta el ciclo recomendado con Docker. |
| `npm run levantar -- --node` | Inicia el CRM local con Node. |
| `npm run paso2` | Configura la integración de Meta después del despliegue. |
| `npm run check` | Ejecuta el diagnóstico de punta a punta; en Docker revisa Supabase desde un contenedor efímero sin mostrar credenciales. |
| `npm run tunel` | Crea una URL pública temporal; detecta Docker en 3300 o Node en 3000, salvo que se defina `PORT`. |
| `npm run vps` | Prepara el despliegue en un servidor con HTTPS. |
| `npm run vincular` | Vincula un archivo de credenciales externo. |

Los scripts están diseñados para poder repetirse sin duplicar los pasos ya
completados.

### Credenciales en más de un equipo

`credenciales.env` nunca debe subirse al repositorio. Para mantener una sola
copia fuera del proyecto:

```bash
npm run vincular -- "C:\ruta\a\la\carpeta\sincronizada\crm.env"
```

El comando mueve el archivo y registra su ubicación en `credenciales.ruta`, que
también está ignorado por Git. `CRM_CREDENCIALES` puede apuntar al archivo de
forma explícita y tiene prioridad.

La `ENCRYPTION_KEY` del flujo local vive en `crm/.env.local`, no en
`credenciales.env`. Si WhatsApp ya está conectado, conserve esa clave al mover
la instalación.

## Qué automatiza

**Supabase:** crea o reutiliza el proyecto, espera a que esté disponible,
obtiene las claves, aplica las migraciones en orden, verifica el esquema,
configura el Site URL de Auth y genera el entorno del CRM.

**Meta, en el flujo clásico:** descubre la cuenta de WhatsApp Business y sus
números, prueba el handshake del webhook, registra la callback, suscribe los
campos necesarios y registra el número cuando corresponde.

**Diagnóstico:** `npm run check` revisa ambos extremos y devuelve errores
accionables sin imprimir secretos.

## Costes y límites

La licencia MIT permite usar y modificar el software, pero la infraestructura y
los proveedores pueden tener costes. Supabase, el servidor y Meta aplican sus
propios planes, límites y tarifas, que pueden cambiar. Este proyecto no promete
un servicio gratuito permanente.

Consulte [`docs/04-costos.md`](docs/04-costos.md) y confirme siempre los precios
actuales en la documentación oficial antes de ofrecer el servicio a terceros.
El uso de la API oficial de Meta tampoco evita suspensiones por incumplimiento de
políticas, baja calidad o falta de consentimiento.

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/01-meta.md`](docs/01-meta.md) | Configuración manual de Meta, paso a paso. |
| [`docs/02-supabase.md`](docs/02-supabase.md) | Token, proyecto y consideraciones de Supabase. |
| [`docs/03-deploy.md`](docs/03-deploy.md) | Túnel temporal y despliegue con HTTPS. |
| [`docs/04-costos.md`](docs/04-costos.md) | Costes, límites y supuestos. |
| [`docs/05-gotchas.md`](docs/05-gotchas.md) | Errores conocidos, causas y soluciones. |

## Licencia y atribución

Este instalador se publica con licencia MIT. El CRM original
[`ArnasDon/wacrm`](https://github.com/ArnasDon/wacrm) también usa la licencia
MIT; al redistribuirlo deben conservarse su aviso de copyright y su archivo
`LICENSE`.

Hecho por [IABYIA](https://iabyia.com.ar).
