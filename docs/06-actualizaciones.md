# Actualizar el CRM

Con el tiempo, [wacrm](https://github.com/ArnasDon/wacrm) publica mejoras y
correcciones. Este documento explica cómo llegan a una instalación que ya está
funcionando, **sin perder datos**.

---

## La idea en una línea

El instalador guarda **qué versión exacta del CRM está probada**. Actualizar es
traer esa versión y aplicar solo lo que falta.

```
ArnasDon/wacrm  ──(se revisa)──▶  crm-version.json  ──(npm run actualizar)──▶  tu CRM
```

Nadie recibe cambios del CRM original que no hayan pasado antes por esa
revisión.

---

## Qué se toca y qué no

| Parte | ¿La afecta una actualización? |
|---|---|
| Contactos, mensajes, conversaciones | **No.** Viven en la base de Supabase. |
| Tokens de WhatsApp | **No.** La `ENCRYPTION_KEY` se conserva en `.env.local`. |
| Código del CRM | **Sí.** Se reemplaza por la versión nueva. |
| Estructura de la base (migraciones) | **Solo si la versión nueva trae migraciones.** |

Las migraciones son el único punto delicado: se ejecutan directamente sobre tus
datos y **no se pueden deshacer**. Por eso, cuando la versión nueva trae
alguna, el actualizador **se detiene sin cambiar nada** hasta que exportes un
respaldo desde Supabase y lo confirmes con `--aplicar-migraciones`. El
instalador no hace ese respaldo por vos.

---

## El archivo de versión

Va en la raíz de este repositorio:

```json
{
  "repo": "https://github.com/ArnasDon/wacrm.git",
  "commit": "<hash completo del commit probado>"
}
```

- `commit` es un hash exacto, no una rama. Así todas las instalaciones tienen
  exactamente el mismo código.
- Las instalaciones nuevas clonan exactamente ese commit.
- `CRM_REPO_URL` (en `.env` o `credenciales.env`) tiene prioridad para quien
  quiera usar otra fuente. En ese caso se sigue la rama por defecto de ese
  repositorio y no se compara con `crm-version.json`.
- Traer un commit puntual con `git fetch --depth 1 origin <hash>` funciona contra
  GitHub (verificado el 2026-09-28).

---

## Pasos para quien mantiene el instalador

Se hace cada vez que el CRM original publica cambios que valen la pena.

1. **Ver qué cambió** desde la versión fijada:

   ```bash
   gh api repos/ArnasDon/wacrm/compare/<commit-actual>...main \
     --jq '.files[].filename'
   ```

2. **Revisar las migraciones nuevas**, es decir, los archivos bajo
   `supabase/migrations/` que aparezcan en la lista. Clasificalas así:
   - **Solo agregan** (tabla, columna o índice nuevos): riesgo bajo.
   - **Renombran, borran o transforman datos**: riesgo alto. Leé el SQL
     completo antes de seguir.

3. **Revisar variables nuevas.** Si cambió `.env.example` del CRM, el
   actualizador **no** las carga (nunca toca `.env.local`): hay que avisarlo en
   el commit o en la documentación.

4. **Probar en una instalación de prueba**, nunca en una con datos reales.

5. **Actualizar `crm-version.json`** con el hash nuevo y publicarlo en `main`
   con un commit del tipo `chore(crm): bump wacrm to <hash corto>`.

---

## Pasos para quien tiene el CRM instalado

```bash
npm run actualizar -- --docker
```

El comando hace esto, en este orden, y se detiene ante el primer problema:

1. **Revisa el instalador.** Si tiene cambios locales en archivos versionados,
   se detiene. Después hace `git pull --ff-only` (se omite con `--sin-pull`).
2. **Reconstruye la imagen de Docker** con el `crm-version.json` nuevo.
3. **Corre el actualizador dentro de Docker** (servicio `updater`, perfil
   `update`). Ahí:
   1. **Compara versiones.** Si ya tenés la fijada, termina sin hacer nada.
   2. **Revisa cambios locales** en el código del CRM. Si alguien lo modificó a
      mano, se detiene y no pisa nada. Los marcadores `.installer-ready.json` y
      `.installer-build.json` no cuentan como cambios: git los ve como archivos
      sin seguimiento, pero son del instalador.
   3. **Descarga** la versión de destino y **detecta migraciones nuevas**
      comparando con las que ya están aplicadas en Supabase. Si hay alguna y no
      pasaste `--aplicar-migraciones`, las lista, explica que tocan datos y no
      se pueden deshacer, y termina **sin cambiar nada**.
   4. **Cambia el código** a esa versión dentro del volumen de Docker.
   5. **Aplica solo las migraciones pendientes** y verifica el esquema.
      Las que ya estaban aplicadas se saltean solas.
   6. **Vuelve a marcar el CRM como listo** para que el marcador registre la
      versión nueva, y muestra la versión anterior y el comando para volver.
4. **Reinicia el CRM** solo si hubo cambio. Al detectar código nuevo,
   reinstala dependencias y recompila. **El CRM no responde mientras tanto**
   (unos 3 minutos; el comando espera hasta que esté saludable).

### Cuando hay migraciones nuevas

El primer intento se detiene y muestra la lista. Entonces:

1. En Supabase: **Database > Backups** (o la exportación que ofrezca tu plan) y
   descargá un respaldo.
2. Repetí con la confirmación:

   ```bash
   npm run actualizar -- --docker --aplicar-migraciones
   ```

Si una migración falla a mitad de camino, el código ya está en la versión nueva:
repetí el mismo comando (las migraciones aplicadas se saltean) o volvé atrás
como se explica más abajo.

### Cómo saber qué versión tenés

`npm run check` muestra la versión instalada (el commit) y la compara con la de
`crm-version.json`. Si difieren, avisa **"Hay una versión nueva del CRM"**; es un
aviso informativo, no una falla.

---

## Volver a una versión anterior

Sirve si la versión nueva anda mal. Lleva unos 3 minutos con el CRM apagado.

1. **Buscá el commit anterior.** El actualizador lo imprime al terminar
   ("Para volver a la anterior: ..."). Si no lo guardaste, sale del historial
   de `crm-version.json`:

   ```bash
   git log -p --follow -- crm-version.json
   ```

2. **Volvé a esa versión** con el hash completo (40 caracteres):

   ```bash
   npm run actualizar -- --docker --commit <hash>
   ```

   Suma `--sin-pull` si querés conservar el instalador como está.

**Las migraciones no se revierten.** Los datos y la estructura de la base se
quedan como están; solo cambia el código.

| Situación | ¿Es seguro volver? |
|---|---|
| Entre las dos versiones **no hubo migraciones** | **Sí.** Código viejo sobre el mismo esquema. |
| Hubo migraciones que **solo agregaron** tablas, columnas o índices | **Probablemente.** El código viejo ignora lo nuevo, pero probalo. |
| Hubo migraciones que **renombraron, borraron o transformaron** datos | **Riesgoso.** El código viejo puede fallar o leer mal los datos. |

Al volver, el actualizador avisa cuando la base tiene migraciones que la versión
elegida no conoce. Como último recurso, restaurá el respaldo de Supabase que
hiciste antes de actualizar (perdés lo que pasó después del respaldo) y luego
volvé al código anterior con el comando de arriba.

---

## Lo que no hay que hacer

- **No uses `docker compose down -v`.** Borra los volúmenes y con ellos la
  instalación.
- **No cambies la `ENCRYPTION_KEY`** para "empezar limpio". Todos los tokens de
  WhatsApp guardados quedan ilegibles.
- **No uses `git clean` dentro de `crm/`.** Borra los marcadores del
  instalador, y con `-x` también `.env.local` y su `ENCRYPTION_KEY`.
- **No edites el código dentro de `crm/`** si pensás actualizar. El
  actualizador lo detecta y se detiene, pero tus cambios no se conservan
  solos.
