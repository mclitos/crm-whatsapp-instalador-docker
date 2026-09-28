import { isFullCommit } from "./crm-source.mjs";
import { applyMigrations as defaultApplyMigrations } from "./supabase-setup.mjs";

const MIGRATIONS_PATH = "supabase/migrations";
const short = (revision) => (revision ? revision.slice(0, 12) : "desconocida");

export class CrmUpdateError extends Error {
  constructor(code, message, action, options) {
    super(message, options);
    this.name = "CrmUpdateError";
    this.code = code;
    this.action = action;
  }
}

export const parseUpdateArguments = (argv) => {
  const options = { commit: null, allowMigrations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--aplicar-migraciones") options.allowMigrations = true;
    else if (argument === "--commit") {
      options.commit = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--commit=")) options.commit = argument.slice("--commit=".length);
    else {
      throw new CrmUpdateError(
        "UNKNOWN_ARGUMENT",
        `Opción desconocida: ${argument}`,
        "Opciones válidas: --commit <hash> y --aplicar-migraciones.",
      );
    }
  }
  return options;
};

/**
 * Decide desde dónde y a qué commit actualizar. Un CRM_REPO_URL propio nunca se
 * mueve solo al commit fijado de ArnasDon: hay que pedir el commit a mano.
 */
export const resolveUpdateSource = ({ commit, source }) => {
  if (source.commit === null && !commit) {
    throw new CrmUpdateError(
      "CUSTOM_SOURCE",
      "Esta instalación sigue otro repositorio (CRM_REPO_URL), no la versión fijada por el instalador.",
      "Indicá a qué versión ir con: npm run actualizar -- --docker --commit <hash completo de 40 caracteres>",
    );
  }
  return { repoUrl: source.repoUrl, target: commit || source.commit };
};

const rollbackCommand = (revision) => `npm run actualizar -- --docker --commit ${revision}`;

const listTargetMigrations = async (git, target) => {
  let output;
  try {
    output = await git(["ls-tree", "-r", "--name-only", target, "--", MIGRATIONS_PATH]);
  } catch (error) {
    throw new CrmUpdateError(
      "TARGET_TREE_UNREADABLE",
      "No pude leer las migraciones de la versión de destino.",
      "Revisá que el commit exista en el repositorio del CRM e intentá de nuevo.",
      { cause: error },
    );
  }
  return output.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".sql"))
    .map((line) => line.split("/").at(-1))
    .map((fileName) => ({ fileName, version: fileName.split("_")[0] }));
};

const isOlder = async (git, target, installed) => {
  try {
    const timestamp = async (revision) => Number((await git(["show", "-s", "--format=%ct", revision])).trim());
    const [targetTime, installedTime] = [await timestamp(target), await timestamp(installed)];
    return Number.isFinite(targetTime) && Number.isFinite(installedTime) && targetTime < installedTime;
  } catch {
    return false;
  }
};

/**
 * Lleva el checkout del CRM a `target`. Orden pensado para no dejar nada a
 * medias: primero se valida todo (cambios locales, migraciones pendientes) y
 * recién después se cambia de commit y se tocan los datos. Si una corrida se
 * interrumpe después del checkout, repetir el comando retoma lo que falte
 * (migraciones, verificación y marcador) aunque el commit ya sea el de destino.
 */
export const runCrmUpdate = async ({
  target,
  repoUrl,
  allowMigrations = false,
  directory,
  git,
  admin,
  ref,
  workspace,
  readRevision,
  readMarkerRevision = async () => null,
  applyMigrations = defaultApplyMigrations,
  log = () => {},
}) => {
  if (!isFullCommit(target)) {
    throw new CrmUpdateError(
      "INVALID_TARGET",
      "El commit de destino no es un hash completo de 40 caracteres.",
      "Copiá el hash completo (git log --format=%H) y pasalo con --commit <hash>.",
    );
  }
  const installed = await readRevision(directory);
  if (!installed) {
    throw new CrmUpdateError(
      "REVISION_UNKNOWN",
      "No pude saber qué versión del CRM está instalada.",
      "Revisá con npm run check que el CRM esté instalado; si falta, corré: npm run levantar -- --docker",
    );
  }
  const sameRevision = installed === target;

  if (!sameRevision) {
    // --untracked-files=no: los marcadores .installer-*.json del instalador no
    // están en el .gitignore del CRM y no son cambios del usuario.
    const changes = (await git(["status", "--porcelain", "--untracked-files=no"])).trim();
    if (changes) {
      throw new CrmUpdateError(
        "LOCAL_CHANGES",
        "El código del CRM tiene cambios locales sin guardar. No toqué nada.",
        "Revisalos dentro del volumen del CRM (git status). Si querés conservarlos, guardalos antes; el actualizador nunca los descarta.",
      );
    }

    log(`Descargando la versión ${short(target)}...`);
    try {
      // Se pide al repositorio explícito, no a `origin`: las instalaciones
      // viejas apuntan a un fork y no se reescribe su configuración.
      await git(["fetch", "--depth", "1", repoUrl, target]);
    } catch (error) {
      throw new CrmUpdateError(
        "FETCH_FAILED",
        "No pude descargar la versión de destino del CRM.",
        "Revisá tu conexión y que el commit exista en el repositorio del CRM. No cambié nada.",
        { cause: error },
      );
    }
  }

  const targetMigrations = await listTargetMigrations(git, target);
  let appliedVersions;
  try {
    appliedVersions = await admin.migracionesAplicadas(ref);
  } catch (error) {
    throw new CrmUpdateError(
      "MIGRATION_READ_FAILED",
      "No pude leer las migraciones ya aplicadas en Supabase. No es seguro continuar.",
      "Revisá que el proyecto de Supabase esté activo y volvé a intentar. No cambié nada.",
      { cause: error },
    );
  }
  const pending = targetMigrations.filter(({ version }) => !appliedVersions.has(version));

  if (sameRevision && pending.length === 0) {
    if ((await readMarkerRevision(directory)) === installed) {
      log(`El CRM ya está en la versión ${short(installed)}. No hay nada que actualizar.`);
      return { status: "unchanged", previous: installed, current: installed };
    }
    log("El código ya está en esa versión, pero el CRM no quedó marcado como listo. Termino de prepararlo.");
  }

  const targetVersions = new Set(targetMigrations.map(({ version }) => version));
  const unknownToTarget = [...appliedVersions].filter((version) => !targetVersions.has(version));
  const rollback = sameRevision ? false : await isOlder(git, target, installed);

  if (pending.length > 0 && !allowMigrations) {
    throw new CrmUpdateError(
      "MIGRATIONS_PENDING",
      `${sameRevision ? "Una actualización anterior se interrumpió: faltan" : "Esta versión trae"} ${pending.length} migración(es) que modifican la base de datos y no se pueden deshacer:\n${pending.map(({ fileName }) => `  - ${fileName}`).join("\n")}`,
      "Primero exportá un backup desde el dashboard de Supabase (Database > Backups). Después repetí el comando agregando --aplicar-migraciones. No cambié nada.",
    );
  }

  if (rollback) {
    log("Aviso: estás volviendo a una versión anterior. Las migraciones ya aplicadas NO se revierten.");
  }
  if (unknownToTarget.length > 0) {
    log(`Aviso: la base tiene ${unknownToTarget.length} migración(es) que esta versión no conoce; el código puede no coincidir con el esquema.`);
  }

  if (!sameRevision) await git(["checkout", "-q", "--detach", target]);

  let appliedCount = 0;
  if (pending.length > 0) {
    log(`Aplicando ${pending.length} migración(es) pendiente(s)...`);
    try {
      const summary = await applyMigrations({ admin, ref, workspace, report: async () => {} });
      appliedCount = summary.applied;
    } catch (error) {
      throw new CrmUpdateError(
        "MIGRATION_FAILED",
        `El código ya está en ${short(target)}, pero una migración falló: ${error.message}`,
        `Repetí el mismo comando (con --aplicar-migraciones): las migraciones ya aplicadas se saltean. Para volver al código anterior: ${rollbackCommand(installed)}`,
        { cause: error },
      );
    }
  }

  const verifySql = await workspace.readVerifySchema();
  if (verifySql) {
    const verification = await admin.sql(ref, verifySql);
    if (!verification?.ok) {
      throw new CrmUpdateError(
        "SCHEMA_VERIFICATION_FAILED",
        "La verificación del esquema falló después de actualizar.",
        `Revisá Supabase y repetí el mismo comando para reintentar. Para volver al código anterior: ${rollbackCommand(installed)}`,
      );
    }
  }

  await workspace.markReady();
  return {
    status: "updated",
    previous: installed,
    current: target,
    migrationsApplied: appliedCount,
    rollback,
    rollbackCommand: rollbackCommand(installed),
  };
};
