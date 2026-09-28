# Instalar wacrm con Docker y Supabase

Este repositorio pone en marcha un CRM de WhatsApp sin incluir ni modificar su
código fuente. La ruta recomendada abre un instalador guiado en
`http://localhost:3300`, prepara Supabase y entrega el CRM terminado en esa
misma dirección.

> **Si no programa:** abra una carpeta vacía con un asistente capaz de trabajar
> con archivos y envíele el enlace de este repositorio junto con: **«Instala
> este CRM con Docker y guíame paso a paso»**. El asistente debe ejecutar los
> comandos; usted solo completa las acciones que requieren acceso a sus cuentas
> de Supabase y Meta.

## Ruta rápida recomendada

Para mantenimiento o instalación manual, necesita
[Git](https://git-scm.com), [Node.js 20 o posterior](https://nodejs.org) y
[Docker](https://www.docker.com/products/docker-desktop/):

```bash
git clone https://github.com/mclitos/crm-whatsapp-instalador-docker.git
cd crm-whatsapp-instalador-docker
npm run levantar -- --docker
```

La consola muestra un **token de configuración de un solo uso**. Después:

1. Abra `http://localhost:3300`.
2. Introduzca el token.
3. Conecte su cuenta de Supabase.
4. Elija un proyecto existente o cree uno nuevo.
5. Espere hasta que el CRM aparezca en la misma dirección.

Durante la espera, el instalador muestra una ruta visual de cinco etapas:

`Cuenta` → `Supabase` → `Base de datos` → `CRM` → `Verificación`

La etapa activa se anima y las etapas terminadas quedan identificadas. El
avance numérico solo aparece cuando existe un total real, por ejemplo al aplicar
migraciones; no se muestran porcentajes inventados durante esperas externas.

> **Conserve la instalación:** para detener los contenedores use
> `docker compose down`. No use `docker compose down -v`, porque `-v` elimina
> los volúmenes persistentes.

## Qué se instala

Hay tres repositorios distintos:

| Repositorio | Responsabilidad |
|---|---|
| [`ArnasDon/wacrm`](https://github.com/ArnasDon/wacrm) | CRM original, publicado con licencia MIT. Se instala el commit exacto revisado que fija `crm-version.json`. |
| [`mclitos/wacrm`](https://github.com/mclitos/wacrm) | Fork mantenido; ya no es el origen predeterminado, pero puede usarse mediante `CRM_REPO_URL`. |
| [`mclitos/crm-whatsapp-instalador-docker`](https://github.com/mclitos/crm-whatsapp-instalador-docker) | Este instalador independiente; coordina Docker y Supabase, pero no contiene una copia del CRM. |

Para instalar desde otro origen, defina `CRM_REPO_URL` en un archivo `.env`
local ignorado por Git (se sigue la rama por defecto de ese repositorio). **No incluya ni edite `crm/` dentro de este
repositorio:** es un workspace clonado y reemplazable, no parte del instalador.

## Cómo funciona la instalación Docker

| Momento | Qué ocurre |
|---|---|
| Instalación | Un instalador web temporal protegido por token ocupa el puerto `3300`. |
| Preparación | Se clona el CRM en un volumen, se crea o reutiliza el proyecto de Supabase, se obtienen sus claves, se aplican las migraciones pendientes, se verifica el esquema, se configura Auth y se escribe el entorno del CRM. |
| Entrega | El instalador temporal se retira y el CRM se construye y arranca en el mismo puerto `3300`. Durante el relevo, la dirección puede dejar de responder brevemente. |
| Uso posterior | El contenedor del CRM reutiliza el código, las dependencias y el build persistidos mientras sigan vigentes. |

**Supabase continúa siendo el backend externo de base de datos y
autenticación.** Docker no crea un PostgreSQL local.

Dos volúmenes con nombre mantienen separadas las responsabilidades:

- `installer-data`: clave maestra y credenciales de Supabase cifradas.
- `crm-source`: código clonado, `.env.local`, dependencias y build del CRM.

El CRM no monta el volumen interno del instalador. Los servicios principales se
ejecutan sin privilegios y el socket de Docker no se comparte con ellos.

### Acceso desde la red local

Para abrir el instalador desde otro equipo de una red privada, cree un archivo
`.env` ignorado por Git con la IP local exacta; no use `0.0.0.0`:

```dotenv
HOST_BIND_ADDRESS=192.168.1.50
PUBLIC_HOST=192.168.1.50
WEB_INSTALLER_SETUP_TOKEN=ejemplo-sintetico-no-es-secreto-000000000000
```

El instalador y el CRM quedarán en `http://192.168.1.50:3300`. Este acceso HTTP
solo es apropiado para pruebas en la red local; Meta y un despliegue real
requieren una URL pública HTTPS.

## Qué se automatiza y qué requiere al propietario

| El instalador automatiza | El propietario todavía debe hacer |
|---|---|
| Validar la cuenta de Supabase. | Crear la cuenta de Supabase y generar su token de acceso. |
| Crear o reutilizar un proyecto y esperar a que esté disponible. | Elegir la organización y confirmar si se usará un proyecto nuevo o existente. |
| Aplicar solo las migraciones pendientes y verificar el esquema. | Revisar el panel si Supabase no confirma de forma inequívoca la creación de un proyecto. |
| Configurar Supabase Auth y generar `.env.local`. | Crear o seleccionar la aplicación de Meta y generar el token permanente del usuario del sistema. |
| En el flujo clásico, configurar el webhook, las suscripciones y el número mediante `npm run paso2`. | Introducir los datos de WhatsApp en `Settings → WhatsApp` dentro del CRM. |

La configuración de WhatsApp se introduce en el CRM deliberadamente: ese
formulario cifra los valores con la `ENCRYPTION_KEY` del propio CRM. El
instalador no escribe directamente en `whatsapp_config`, de modo que la
implementación de cifrado del proyecto upstream sigue siendo la autoridad.

Consulte la guía de [Meta y WhatsApp](docs/01-meta.md) cuando el CRM ya esté
funcionando.

## Seguridad y conservación de datos

Antes de operar una instalación, respete estas reglas:

- **Nunca confirme secretos en Git.** No publique tokens, contraseñas, claves de
  servicio, `.env`, `credenciales.env` ni archivos del entorno del CRM, incluso
  en un repositorio privado.
- **Nunca rote `ENCRYPTION_KEY` en una instalación existente.** Los tokens de
  WhatsApp cifrados dejarían de ser legibles y habría que conectar la cuenta de
  nuevo.
- **Nunca use `docker compose down -v`** si desea conservar la instalación.
- **No versione ni modifique el workspace `crm/`.** Use `CRM_REPO_URL` para
  seleccionar otro repositorio del CRM.
- Introduzca los valores de WhatsApp mediante `Settings → WhatsApp`; no replique
  el cifrado ni escriba la tabla de configuración desde fuera.

## Recuperar, revisar o reconfigurar

Si el proceso se interrumpe, repita el comando recomendado:

```bash
npm run levantar -- --docker
```

Las migraciones aplicadas quedan registradas y no se duplican. Si Supabase pudo
crear un proyecto pero el instalador no pudo guardar su referencia, revise el
panel antes de reintentar para evitar crear otro proyecto.

Para elegir otro proyecto o cambiar deliberadamente la URL pública:

```bash
npm run levantar -- --docker --reconfigure
```

Para ejecutar el diagnóstico de punta a punta sin imprimir credenciales:

```bash
npm run check
```

## Actualizar el CRM

El instalador fija en `crm-version.json` la versión de wacrm que fue revisada.
Para llevar una instalación Docker a esa versión:

```bash
npm run actualizar -- --docker
```

El comando actualiza el instalador, descarga la versión revisada, aplica solo
las migraciones pendientes y reinicia el CRM. Los contactos, los mensajes y la
`ENCRYPTION_KEY` se conservan. Mientras compila la versión nueva, el CRM deja
de responder durante unos 3 minutos.

| Situación | Qué hace el comando |
|---|---|
| Ya tiene la versión revisada | Termina sin cambiar nada. |
| La versión nueva trae migraciones | Se detiene sin tocar nada. Exporte un backup en Supabase y repita con `--aplicar-migraciones`. |
| El código del CRM tiene cambios locales | Se detiene y no los pisa. |
| Una actualización anterior se interrumpió | Repetir el comando la completa. |

Para volver a una versión anterior, use el commit que el comando muestra al
terminar:

```bash
npm run actualizar -- --docker --commit <hash>
```

Las migraciones ya aplicadas no se revierten. `npm run check` muestra la
versión instalada y avisa cuando hay una más nueva. Consulte los detalles en
[Actualizaciones](docs/06-actualizaciones.md).

## Comandos disponibles

La ruta Docker anterior es la opción principal. Estos comandos existen para
diagnóstico, despliegue o flujos avanzados:

| Comando | Uso |
|---|---|
| `npm run web` | Abre el instalador local sin Docker en `http://127.0.0.1:7359`. |
| `npm run instalar` | Ejecuta el flujo clásico por consola. |
| `npm run creds` | Valida las credenciales del flujo clásico. |
| `npm run paso1` | Prepara Supabase, sus migraciones, Auth y el entorno del CRM. |
| `npm run paso2` | Configura Meta y WhatsApp después de disponer de una URL pública. |
| `npm run levantar` | Elige Docker cuando está disponible o usa Node como alternativa. |
| `npm run levantar -- --node` | Inicia el CRM localmente con Node. |
| `npm run check` | Diagnostica el estado de la instalación. |
| `npm run actualizar -- --docker` | Actualiza el CRM a la versión revisada o, con `--commit`, a otra versión. |
| `npm run tunel` | Crea una URL pública temporal para pruebas. |
| `npm run vps` | Prepara el despliegue con HTTPS desde el servidor. |
| `npm run vincular` | Vincula un archivo de credenciales almacenado fuera del repositorio. |

El modo web sin Docker prepara el workspace en `./crm`; no lo convierta en
código propio de este repositorio. El túnel es temporal y no sustituye un
despliegue estable para producción.

## Publicar el CRM y conectar WhatsApp

`localhost` permite completar la instalación, pero Meta necesita llegar a una
URL pública HTTPS para entregar eventos al webhook.

- Para una prueba: siga la guía del [túnel temporal](docs/03-deploy.md).
- Para uso continuo: despliegue el CRM con una dirección estable y HTTPS.
- Después: complete [la configuración de Meta](docs/01-meta.md), introduzca los
  valores en el CRM y ejecute el diagnóstico.

El software tiene licencia MIT, pero Supabase, el alojamiento, Meta y los
proveedores de IA pueden aplicar límites o costes. Consulte
[costes y supuestos](docs/04-costos.md) y confirme siempre las tarifas actuales
en la documentación oficial. La API oficial de Meta tampoco evita suspensiones
por incumplimiento de políticas, calidad baja o falta de consentimiento.

## Documentación

| Guía | Cuándo consultarla |
|---|---|
| [Meta y WhatsApp](docs/01-meta.md) | Para crear la aplicación, obtener el token permanente y preparar el número. |
| [Supabase](docs/02-supabase.md) | Para obtener el token, reutilizar un proyecto o entender sus límites. |
| [Despliegue](docs/03-deploy.md) | Para exponer el CRM temporalmente o publicarlo con HTTPS. |
| [Costes](docs/04-costos.md) | Antes de presupuestar infraestructura o mensajería. |
| [Problemas conocidos](docs/05-gotchas.md) | Cuando el diagnóstico señala una configuración incompleta o algo deja de responder. |
| [Actualizaciones](docs/06-actualizaciones.md) | Para actualizar el CRM instalado con `npm run actualizar -- --docker` o volver a una versión anterior. |

## Licencia y atribución

Este instalador se publica con licencia MIT. El CRM original
[`ArnasDon/wacrm`](https://github.com/ArnasDon/wacrm) también usa la licencia
MIT; al redistribuirlo deben conservarse su aviso de copyright y su archivo
`LICENSE`.

Hecho por [IABYIA](https://iabyia.com.ar).
