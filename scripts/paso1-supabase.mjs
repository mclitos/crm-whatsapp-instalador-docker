#!/usr/bin/env node
/**
 * npm run paso1 — todo lo de Supabase, de una.
 *
 * Reemplaza estos pasos del tutorial manual:
 *   · crear el proyecto y anotar la contraseña en un bloc de notas
 *   · buscar la URL, la anon key y la service_role key en tres pantallas
 *   · generar el ENCRYPTION_KEY a mano con node -e
 *   · PEGAR 39 ARCHIVOS SQL, UNO POR UNO, EN EL SQL EDITOR   ← el peor
 *   · crear el .env.local a mano copiando del ejemplo
 *   · (y el que el tutorial ni hace: configurar el Site URL, que es la causa
 *      real del mail de confirmación que apunta a localhost:3000)
 *
 * Es idempotente: si lo corrés dos veces, no duplica nada ni rota tu
 * ENCRYPTION_KEY (rotarla dejaría huérfanos los tokens ya guardados).
 */

import {
  CRM_DIR, C, ok, fail, warn, info, encabezado, titulo, progreso, morir, salir,
  leerEnv, escribirEnv, leerEstado, guardarEstado, preguntar, elegir,
  rutaCredenciales,
} from "./lib/ui.mjs";
import { SupabaseAdmin, generarDbPass } from "./lib/supabase.mjs";
import { resolveCrmRepoUrl } from "./lib/crm-source.mjs";
import { CrmWorkspace } from "./lib/crm-workspace.mjs";

const CREDS = rutaCredenciales();

const creds = leerEnv(CREDS);
if (!creds.SUPABASE_ACCESS_TOKEN) {
  morir("Falta el SUPABASE_ACCESS_TOKEN.", "Corré primero:  npm run creds");
}

const estado = leerEstado();
encabezado("Paso 1 — Supabase", "proyecto, llaves, migraciones y auth");

// ── 1. la cuenta ────────────────────────────────────────────────────────────
titulo("1. Cuenta de Supabase");

const supa = new SupabaseAdmin(creds.SUPABASE_ACCESS_TOKEN);
const orgs = await supa.organizaciones();
if (!orgs.ok) {
  morir(
    `El token de Supabase no funciona: ${orgs.error}`,
    "Generá uno nuevo en supabase.com/dashboard/account/tokens y actualizá credenciales.env",
  );
}
const listaOrgs = orgs.json || [];
ok(`Token válido`, `${listaOrgs.length} organización(es)`);

// The shared workspace validates the clone without modifying a valid checkout.
// Account validation deliberately happens first, before cloning or writing.
// ── 2. el código del CRM ────────────────────────────────────────────────────
titulo("2. Código del CRM");
const workspace = new CrmWorkspace({ directory: CRM_DIR });
try {
  const prepared = await workspace.ensure(resolveCrmRepoUrl({ credentials: creds }));
  if (prepared.cloned) ok("Clonado en ./crm");
  else ok("./crm ya existe", "no lo toco (si querés actualizarlo: cd crm && git pull)");
} catch (error) {
  morir(error.message, "Revisá que git esté instalado y que ./crm no sea un checkout incompleto.");
}
const migrationEntries = await workspace.readMigrations();
const migraciones = migrationEntries.map((migration) => migration.fileName);
ok(`${migraciones.length} migraciones encontradas`, `${migraciones[0]} … ${migraciones.at(-1)}`);

// ── 3. el proyecto ──────────────────────────────────────────────────────────
titulo("3. Proyecto");

let ref = creds.SUPABASE_PROJECT_REF || estado.projectRef || "";

if (ref) {
  const p = await supa.proyecto(ref);
  if (!p.ok) {
    morir(
      `No encuentro el proyecto "${ref}": ${p.error}`,
      "Revisá el SUPABASE_PROJECT_REF de credenciales.env, o dejalo vacío para crear uno nuevo.",
    );
  }
  ok(`Uso el proyecto existente "${p.json.name}"`, `${ref} · ${p.json.region} · ${p.json.status}`);
} else {
  const org =
    listaOrgs.length === 1
      ? listaOrgs[0]
      : (await elegir(
          "¿En qué organización lo creo?",
          listaOrgs.map((o) => ({ label: `${o.name} ${C.dim(`(${o.slug})`)}`, valor: o })),
        )).valor;

  const nombre = await preguntar("  Nombre del proyecto", { porDefecto: "crm-whatsapp" });
  const region = await preguntar("  Región", { porDefecto: "sa-east-1" });

  console.log("");
  info(`Creando "${nombre}" en ${region} (plan free)…`);
  const dbPass = generarDbPass();
  // The password cannot be recovered from Supabase, so persist it before the
  // create request. A successful response is followed immediately by the ref.
  escribirEnvCreds({ ...creds, SUPABASE_DB_PASSWORD: dbPass });
  const creado = await supa.crearProyecto({
    nombre, dbPass, organizacion: org.slug, region, plan: "free",
  });
  if (!creado.ok) {
    morir(
      `No pude crear el proyecto: ${creado.error}`,
      "Si ya tenés 2 proyectos free, Supabase no deja crear más: pausá uno o pegá el ref de uno existente en credenciales.env.",
    );
  }
  ref = creado.json.ref || creado.json.id;
  ok(`Proyecto creado`, ref);
  guardarEstado({ projectRef: ref, dbPassGuardada: true });

  escribirEnvCreds({ ...creds, SUPABASE_PROJECT_REF: ref, SUPABASE_DB_PASSWORD: dbPass });
  info("Guardé el ref y la contraseña de la base en credenciales.env");
}
guardarEstado({ projectRef: ref });
process.stdout.write(`  ${C.dim("Esperando a que la base esté saludable")}`);
const listo = await supa.esperarProyecto(ref, {
  onTick: (est, seg) => process.stdout.write(C.dim(` ${est}(${seg}s)`)),
});
console.log("");
if (!listo.ok) {
  morir(
    `La base no llegó a estar lista (último estado: ${listo.estado}).`,
    `Mirá https://supabase.com/dashboard/project/${ref} y volvé a correr el paso 1 cuando esté verde.`,
  );
}
ok("Base arriba", "ACTIVE_HEALTHY");

// ── 4. las llaves ───────────────────────────────────────────────────────────
titulo("4. Llaves de la API");

const llaves = await supa.llaves(ref);
if (!llaves.ok) morir(`No pude leer las llaves: ${llaves.error}`);
ok("URL, anon key y service_role obtenidas", `formato: ${llaves.tipo}`);

// ── 5. las migraciones ──────────────────────────────────────────────────────
titulo("5. Migraciones");
info("Esto es lo que el tutorial hace copiando y pegando 39 veces a mano.");

const prep = await supa.prepararTablaMigraciones(ref);
if (!prep.ok) {
  morir(
    `No pude preparar la tabla de migraciones: ${prep.error}`,
    "Si el proyecto se acaba de crear, esperá un minuto y volvé a correr el paso 1.",
  );
}

let yaAplicadas;
try {
  yaAplicadas = await supa.migracionesAplicadas(ref);
} catch (error) {
  morir(error.message, "No es seguro continuar sin saber qué migraciones ya se aplicaron.");
}
if (yaAplicadas.size) info(`${yaAplicadas.size} ya estaban aplicadas — las salteo`);

let aplicadas = 0, salteadas = 0;
const fallidas = [];

for (const [i, archivo] of migraciones.entries()) {
  const version = archivo.split("_")[0];
  const nombre = archivo.replace(/^\d+_/, "").replace(/\.sql$/, "");

  if (yaAplicadas.has(version)) {
    salteadas++;
    progreso(i + 1, migraciones.length, `${archivo} (ya estaba)`);
    continue;
  }

  progreso(i + 1, migraciones.length, archivo);
  const sql = migrationEntries[i].sql;
  const r = await supa.aplicarMigracion(ref, { version, name: nombre, sql });

  if (!r.ok) {
    fallidas.push({
      archivo,
      error: `${r.error}. El SQL y su historial se guardan juntos: reintentá; si ya quedó aplicada, se salteará automáticamente.`,
    });
    break; // si una falla, las siguientes asumen su esquema: no tiene sentido seguir
  }
  aplicadas++;
}
progreso(migraciones.length, migraciones.length, "");

if (fallidas.length) {
  const f = fallidas[0];
  console.log("");
  fail(`Falló ${f.archivo}`, f.error);
  console.log(
    C.dim(
      `\n  Las ${aplicadas} anteriores quedaron aplicadas y registradas: cuando arregles esto,\n` +
        `  volvé a correr ${C.bold("npm run paso1")} y sigue desde donde quedó.\n` +
        `  Si no entendés el error, pegáselo a Claude Code — tiene el SQL a mano en\n` +
        `  ./crm/supabase/migrations/${f.archivo}\n`,
    ),
  );
  salir(1);
}
ok(`${aplicadas} aplicadas · ${salteadas} ya estaban`, `${migraciones.length} en total`);

// ── 6. verificación del esquema ─────────────────────────────────────────────
titulo("6. Verificación del esquema");

const verifySql = await workspace.readVerifySchema();
if (verifySql) {
  const r = await supa.sql(ref, verifySql);
  if (r.ok) ok("El esquema pasa la verificación del propio proyecto");
  else morir(`La verificación falló: ${r.error}`, "alguna migración corrió a medias; no es seguro continuar");
} else {
  warn("El repo no trae supabase/ci/verify-schema.sql", "salteo la verificación");
}

const tablas = await supa.sql(
  ref,
  "select count(*)::int as n from information_schema.tables where table_schema='public';",
);
if (tablas.ok) {
  const n = (Array.isArray(tablas.json) ? tablas.json[0] : tablas.json?.result?.[0])?.n;
  if (n) ok(`${n} tablas en el esquema public`);
}

// ── 7. auth ─────────────────────────────────────────────────────────────────
titulo("7. Auth (el arreglo del mail que apunta a localhost)");

const publicUrl = (creds.PUBLIC_URL || "").replace(/\/+$/, "");

// Mientras estemos probando, la confirmación por mail va apagada: entrar al
// CRM no puede depender de que llegue un correo (el SMTP compartido de
// Supabase tiene un límite bajísimo). Se enciende recién con un dominio de
// verdad.
//
// "Probando" no es solo localhost: una dirección de túnel es igual de
// provisoria — cambia cada vez que se reabre y no sobrevive a cerrar la
// ventana. Tratarla como producción le pediría confirmar el mail justo en el
// momento en que está probando.
const ES_TUNEL = /\.(trycloudflare\.com|loca\.lt|ngrok\.io|ngrok-free\.app|serveo\.net)$/i;
const esTunel = publicUrl && ES_TUNEL.test(new URL(publicUrl).hostname);
const probando = !publicUrl || esTunel;
const siteUrl = publicUrl || "http://localhost:3000";

const rAuth = await supa.configurarAuth(ref, { siteUrl, autoconfirmar: probando });
if (!rAuth.ok) {
  warn(`No pude configurar Auth: ${rAuth.error}`, "se hace a mano en Authentication → URL Configuration");
} else if (probando) {
  ok(`Site URL = ${siteUrl}`, esTunel ? "túnel de pruebas" : "modo local");
  ok("Confirmación por mail DESACTIVADA", "para probar sin esperar correos");
  info("Con un dominio propio (no un túnel) se reactiva sola.");
} else {
  ok(`Site URL = ${siteUrl}`);
  ok("Confirmación por mail activada", "como corresponde en producción");
  info("Los mails de confirmación y de reset ahora apuntan a tu dominio,");
  info("no a localhost:3000. Ese 'bug' del tutorial era esto.");
}

// ── 8. .env.local del CRM ───────────────────────────────────────────────────
titulo("8. Archivo .env.local del CRM");

const locale = await workspace.detectLocale();
await workspace.writeEnvironment({
  supabaseUrl: llaves.url,
  anonKey: llaves.anon,
  serviceRoleKey: llaves.serviceRole,
  publicUrl: publicUrl || "http://localhost:3000",
  locale,
  metaAppSecret: creds.META_APP_SECRET || "",
  metaAppId: creds.META_APP_ID || "",
});
ok("ENCRYPTION_KEY y AUTOMATION_CRON_SECRET conservadas si ya existían");
ok("crm/.env.local escrito", `locale: ${locale}`);

// ── cierre ──────────────────────────────────────────────────────────────────
console.log(`\n${C.green(C.bold("✓ Supabase listo."))}`);
console.log(C.dim(`  Proyecto: https://supabase.com/dashboard/project/${ref}`));
console.log("");
console.log(`  ${C.bold("Ahora:")}`);
if (!publicUrl) {
  console.log(`   1. Levantá el CRM:      ${C.bold("npm run levantar")}`);
  console.log(`   2. Publicalo (dominio o túnel) → ${C.dim("docs/03-deploy.md")}`);
  console.log(`   3. Poné esa URL en ${C.bold("PUBLIC_URL")} de credenciales.env`);
  console.log(`   4. ${C.bold("npm run paso1")} otra vez ${C.dim("(para el Site URL)")} y después ${C.bold("npm run paso2")}`);
} else {
  console.log(`   1. Asegurate de que ${publicUrl} esté respondiendo`);
  console.log(`   2. ${C.bold("npm run paso2")} ${C.dim("(conecta WhatsApp)")}`);
}
console.log("");

// ── helpers ─────────────────────────────────────────────────────────────────
function escribirEnvCreds(valores) {
  escribirEnv(
    CREDS,
    [
      { titulo: "SUPABASE", vars: {
        SUPABASE_ACCESS_TOKEN: valores.SUPABASE_ACCESS_TOKEN || "",
        SUPABASE_PROJECT_REF: valores.SUPABASE_PROJECT_REF || "",
        SUPABASE_DB_PASSWORD: valores.SUPABASE_DB_PASSWORD || "",
      }},
      { titulo: "META / WHATSAPP", vars: {
        META_APP_ID: valores.META_APP_ID || "",
        META_APP_SECRET: valores.META_APP_SECRET || "",
        META_ACCESS_TOKEN: valores.META_ACCESS_TOKEN || "",
        META_WABA_ID: valores.META_WABA_ID || "",
      }},
      { titulo: "DOMINIO", vars: {
        PUBLIC_URL: valores.PUBLIC_URL || "",
        VERIFY_TOKEN: valores.VERIFY_TOKEN || "",
      }},
      ...(valores.CRM_REPO_URL ? [{ titulo: "ORIGEN DEL CRM", vars: {
        CRM_REPO_URL: valores.CRM_REPO_URL,
      }}] : []),
    ],
    "CREDENCIALES — generado por el instalador.\nNO subir a GitHub. NO mostrar si grabás pantalla.",
  );
}
