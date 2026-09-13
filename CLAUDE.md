# Briefing de crm-whatsapp-instalador-docker para Claude Code

Este repositorio es un **instalador independiente**, no el CRM ni una copia
incluida de su código. Automatiza Docker y Supabase para instalar
[wacrm](https://github.com/ArnasDon/wacrm), un CRM de WhatsApp open source con
licencia MIT.

Hay tres identidades que no deben confundirse:

1. `ArnasDon/wacrm` es el CRM original.
2. `mclitos/wacrm` es el fork mantenido que se clona de forma predeterminada
   para dar una base de instalación controlada. Puede reemplazarse mediante
   `CRM_REPO_URL`.
3. `mclitos/crm-whatsapp-instalador-docker` es este instalador independiente.

Supabase sigue siendo el backend de base de datos y autenticación. Docker
ejecuta el instalador y administra el ciclo de vida del CRM.

---

## ⭐ Si te llegó solo un link, en una carpeta vacía

Es el caso más común y el que la persona espera que funcione: abre una carpeta
vacía, te pega el link de este repo y te dice **"instalame este CRM"**. No
quiere tocar la terminal ni escribir un comando — para eso te tiene a vos.

**Entonces corré vos los comandos. Todos.** La persona solo mira, contesta lo
que le preguntes, y hace unos clics en Meta y Supabase cuando se lo pidas.

```bash
git clone https://github.com/mclitos/crm-whatsapp-instalador-docker.git
cd crm-whatsapp-instalador-docker
npm run levantar -- --docker
```

La ruta Docker es la opción recomendada. La consola muestra un token de un solo
uso; la persona abre `http://localhost:3300`, configura Supabase y espera a que
el CRM aparezca en esa misma dirección. Meta se configura después y requiere
acciones manuales del propietario de la cuenta.

Nunca le digas "ahora corré X". Corrélo y contale qué pasó.

---

## ⭐ Lo primero: tomá la iniciativa

Quien abre este repo casi siempre quiere montar su CRM y **no sabe por dónde
empezar ni qué pedirte**. Mucha gente que llega acá no programa. No esperes una
instrucción precisa: puede escribirte "hola", "¿esto qué es?", "ayudame" o
pegarte un error suelto.

**Ante el primer mensaje, sea cual sea:**

1. **Revisá el estado de la instalación** antes de responder: comprobá los
   servicios y volúmenes de Docker, y después `credenciales.env`,
   `credenciales.ruta` o `crm/` si se utilizó el flujo local. `npm run check`
   indica dónde quedó el proceso.
2. **Si no hay nada empezado**, presentate en dos líneas —qué es esto y cuánto
   tarda— y ofrecé arrancar. No pidas permiso tres veces.
3. **Si hay algo a medias**, decile en qué punto está y cuál es el próximo paso.
4. Seguí la skill **`instalar-crm`** (`.claude/skills/instalar-crm/SKILL.md`):
   tiene el flujo completo, los errores típicos y cómo hablarle.

Nunca le vuelques la lista entera de pasos: **una cosa a la vez**. La persona
tiene que poder seguirte sin entender qué es un webhook.

---

## Qué hay acá

```
scripts/
  lib/ui.mjs          salida por consola, prompts, .env, estado local
  lib/supabase.mjs    cliente de la Management API de Supabase
  lib/meta.mjs        cliente de la Graph API de Meta
  credenciales.mjs    valida los 4 datos y explica de dónde sale cada uno
  paso1-supabase.mjs  proyecto + llaves + ~39 migraciones + auth + .env.local
  paso2-meta.mjs      WABA + número + webhook + suscripciones + registro
  levantar.mjs        npm install + arranque (Docker si hay, Node si no)
  check.mjs           diagnóstico completo, solo lectura
  instalar.mjs        encadena todo
  web.mjs              instalador web local y base del modo Docker
compose.yaml            ciclo del instalador y del CRM en el puerto 3300
Dockerfile              imagen sin privilegios para ambos servicios
docs/                 01-meta · 02-supabase · 03-deploy · 04-costos · 05-gotchas
crm/                  clon local del CRM (gitignoreado, no versionado aquí)
credenciales.env      secretos del usuario (gitignoreado)
```

**Cero dependencias npm.** Todo sale de Node 20+: `fetch`, `crypto`,
`readline`. Es a propósito — un `npm install` que falla en la máquina de alguien
que no programa es una instalación perdida.

---

## Reglas

1. **No incluyas ni versiones `crm/`.** El origen predeterminado es
   `https://github.com/mclitos/wacrm.git`, fork mantenido de
   `ArnasDon/wacrm`. El código se clona durante la instalación y puede usarse
   otro origen mediante `CRM_REPO_URL`. Incluir una copia congelada haría que el
   instalador envejeciera con el CRM.

2. **No rotes la `ENCRYPTION_KEY`.** El paso 1 la conserva si ya existía.
   Rotarla deja ilegibles todos los tokens de WhatsApp ya guardados y obliga a
   reconectar a mano. Está comentado en el código: no lo "simplifiques".

   En Docker, tampoco uses `docker compose down -v` si se debe conservar la
   instalación: esa opción elimina los volúmenes persistentes.

3. **No repliques la encriptación del CRM.** Los cuatro valores de WhatsApp se
   cargan a mano en `Settings → WhatsApp` porque ese formulario los encripta con
   AES-256-GCM usando la `ENCRYPTION_KEY`. Escribir la tabla `whatsapp_config`
   desde afuera nos ataría a un detalle interno del upstream. Es un paso de 30
   segundos y vale la pena.

4. **No inventes endpoints.** Los que usa el instalador están verificados contra
   las specs oficiales:
   - Supabase: `https://api.supabase.com/api/v1-json` — `POST /v1/projects`,
     `GET /v1/projects/{ref}`, `GET /v1/projects/{ref}/api-keys[/legacy]`,
     `POST /v1/projects/{ref}/database/query`, `GET|PATCH /v1/projects/{ref}/config/auth`.
   - Meta: Graph API `v26.0` (override con `GRAPH_API_VERSION`).
   Si necesitás uno nuevo, verificalo antes de escribirlo.

5. **Nunca imprimas ni repitas un secreto.** Hay un helper `enmascarar()`.
   Los tokens van a `credenciales.env` y a `crm/.env.local`, ambos gitignoreados.
   **Nunca los commitees**, ni "temporalmente" ni a un repo privado: git guarda
   el historial para siempre y este repo está hecho para compartirse. Si alguien
   quiere sincronizar credenciales entre máquinas, la respuesta es
   `npm run vincular` (las guarda afuera y deja un puntero gitignoreado), no
   sacarlas del `.gitignore`.

   Los scripts NUNCA deben hacer `resolve(ROOT, "credenciales.env")` a mano:
   siempre `rutaCredenciales()`, que respeta `CRM_CREDENCIALES` y el puntero.

6. **Todo idempotente.** Cualquier script se tiene que poder correr dos veces
   sin romper nada. Las migraciones se registran en
   `supabase_migrations.schema_migrations` con el mismo formato que usa el CLI
   de Supabase, así que un `supabase db push` posterior las respeta.

7. **Errores en castellano y accionables.** El patrón es `fail(qué, cómo se
   arregla)`. Nunca dejes un error crudo de la API como única salida.

---

## Decisiones que ya se tomaron (no las revisites sin motivo)

- **La Management API en vez del CLI de Supabase.** El CLI necesita instalación
  global y, para varias operaciones, Docker. `POST /database/query` es el mismo
  camino que usa el SQL Editor del dashboard y no necesita nada.
- **El handshake del webhook se prueba localmente antes de llamar a Meta.**
  Convierte un error genérico de Meta en un diagnóstico preciso (403 = verify
  token distinto, 404 = app caída). Ver `paso2-meta.mjs` sección 5.
- **`sa-east-1` por defecto** al crear el proyecto: es la región más cercana
  para el cono sur.
- **Docker es la ruta recomendada.** `levantar.mjs` conserva Node como
  alternativa local cuando Docker no está disponible.

---

## Por qué existe

Los tutoriales que andan dando vuelta para montar este CRM hacen la instalación
en unos **41 pasos manuales**, incluyendo **pegar 39 archivos SQL uno por uno**
en el editor de Supabase. Varios además generan un Dockerfile que el repo ya
trae, y dicen que "le falta IA" cuando el asistente ya viene incluido.

Casi todo eso es una llamada a una API. El valor de esto no es el acceso al
código —wacrm es público y tiene miles de forks— sino **que alguien lo tenga
andando en veinte minutos en vez de en cuatro horas**, sin quedarse a mitad de
camino, y sabiendo lo que realmente cuesta (`docs/04-costos.md`).

Por eso, si vas a cambiar algo, el criterio es siempre el mismo: **¿esto le
ahorra un paso, un error o una hora a alguien que no programa?**
